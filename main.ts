import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

/**
 * Device Profile - Stores profile name and replacements for a specific vault path
 */
interface DeviceProfile {
	profileName: string; // User-defined short name for this vault (max 20 chars)
	vaultPath: string; // Absolute path to the vault
	linkReplacements: Record<string, string>; // Key-value pairs specific to this vault. Use "@@IGNORE@@" to mark a key as ignored on this device
}

/**
 * Link opening preference for external links
 * Each flag can be toggled independently
 */
interface OpenInPreference {
	webviewer: boolean; // Show webviewer option
	external: boolean;  // Show external browser option
}

/**
 * Link Injection Plugin Settings
 *
 * This plugin provides:
 * 1. Link pattern replacement: ${KEY} for dictionary values, ${L:property} for note properties
 * 2. Device profiles: Separate replacement values per vault path (useful when syncing settings)
 * 3. Default + Override system: Default values apply to all profiles, with optional profile-specific overrides
 */
interface MyPluginSettings {
	// Device Profile Settings
	deviceProfiles: DeviceProfile[]; // Array of profiles, one per vault path

	// Default Link Replacements (apply to all profiles unless overridden)
	defaultLinkReplacements: Record<string, string>; // Default key-value pairs

	// Open In Preference for external links (webviewer vs external browser)
	openInPreferences: Record<string, OpenInPreference>; // Key -> preference mapping

	// Character Replacement for ${L:property} patterns
	invalidCharReplacement: string; // Character to replace /, \, : in property values (for internal links only)
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	deviceProfiles: [], // No profiles by default
	defaultLinkReplacements: {}, // No default replacements by default
	openInPreferences: {}, // No preferences by default (defaults to 'both')
	invalidCharReplacement: ' ' // Replace invalid chars with space by default
}

/**
 * Choice Selection Modal for Internal Links with OR patterns
 * Displays options when user clicks a link with ${one,two,three} pattern
 */
class LinkChoiceModal extends Modal {
	choices: Array<{label: string; url: string; value: string}>;
	onChoose: (url: string) => void;

	constructor(app: App, choices: Array<{label: string; url: string; value: string}>, onChoose: (url: string) => void) {
		super(app);
		this.choices = choices;
		this.onChoose = onChoose;
	}

	onOpen() {
		const {contentEl} = this;

		contentEl.empty();
		contentEl.createEl('h2', { text: 'Choose a link to open' });

		this.choices.forEach((choice) => {
			const button = contentEl.createEl('button', {
				text: choice.url,
				cls: 'mod-cta',
				attr: {
					style: 'width: 100%; margin: 5px 0; padding: 10px; text-align: left;'
				}
			});

			button.addEventListener('click', () => {
				this.onChoose(choice.url);
				this.close();
			});
		});
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

/**
 * Main Plugin Class
 *
 * Features:
 * 1. Pattern Replacement: ${KEY} and ${L:property} patterns in links
 * 2. Monkey-patching: Intercepts link opening to apply replacements
 * 3. External URL Handling: Context menu integration for external links
 */
export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	private readonly pattern = /\$\{([^}]+)\}/g; // Regex to match ${...} patterns
	private hasPropertyError: boolean = false; // Track if property resolution failed (cancels link opening)

	/**
	 * Get the current vault's absolute path
	 */
	getCurrentVaultPath(): string {
		// @ts-ignore - adapter.basePath exists in Obsidian
		return this.app.vault.adapter.basePath || '';
	}

	/**
	 * Get the current device profile for this vault
	 * Returns undefined if no profile exists for this vault path
	 */
	getCurrentProfile(): DeviceProfile | undefined {
		const currentPath = this.getCurrentVaultPath();
		return this.settings.deviceProfiles.find(p => p.vaultPath === currentPath);
	}

	/**
	 * Get the active link replacements for the current vault profile
	 * Merges default replacements with profile-specific overrides
	 * Profile overrides take precedence over defaults
	 */
	getActiveLinkReplacements(): Record<string, string> {
		const profile = this.getCurrentProfile();
		// Start with defaults, then override with profile-specific values
		const merged = {
			...this.settings.defaultLinkReplacements,
			...(profile ? profile.linkReplacements : {})
		};

		// Filter out ignored keys (marked with @@IGNORE@@)
		const filtered: Record<string, string> = {};
		for (const [key, value] of Object.entries(merged)) {
			if (value !== '@@IGNORE@@') {
				filtered[key] = value;
			}
		}
		return filtered;
	}

	/**
	 * Check if a key is marked as ignored in the current profile (case-insensitive)
	 * @param key - The dictionary key to check
	 * @returns true if the key is ignored, false otherwise
	 */
	private isKeyIgnored(key: string): boolean {
		const currentProfile = this.getCurrentProfile();
		if (!currentProfile) return false;

		// Case-insensitive lookup in profile's linkReplacements
		const actualKey = Object.keys(currentProfile.linkReplacements).find(
			k => k.toLowerCase() === key.toLowerCase()
		);

		return actualKey ? currentProfile.linkReplacements[actualKey] === '@@IGNORE@@' : false;
	}

	/**
	 * Get the open-in preference for a specific key
	 * @param key - The dictionary key
	 * @returns Preference object (defaults to both enabled)
	 */
	getOpenInPreference(key: string): OpenInPreference {
		// Case-insensitive lookup to match dictionary behavior
		const actualKey = Object.keys(this.settings.openInPreferences).find(
			k => k.toLowerCase() === key.toLowerCase()
		);
		return actualKey
			? this.settings.openInPreferences[actualKey]
			: { webviewer: true, external: true };
	}

	/**
	 * Remove "dummy://" prefix from URL if present
	 * This prefix is used to trick Obsidian into recognizing links as external
	 * @param url - The URL that may contain the dummy:// prefix
	 * @returns URL with dummy:// prefix removed
	 */
	private removeDummyPrefix(url: string): string {
		if (url.startsWith('dummy://')) {
			return url.substring(8); // Remove first 8 characters
		}
		return url;
	}

	/**
	 * Extract all dictionary keys from a URL pattern
	 * Excludes ${L:property} patterns, only returns regular ${KEY} patterns
	 * Note: OR patterns with ,, are NOT expanded here - they're handled separately
	 * @param text - URL text that may contain ${KEY} patterns
	 * @returns Array of key names
	 */
	private extractKeysFromPattern(text: string): string[] {
		const keys: string[] = [];
		const orPatternRegex = /\$\{([^}]+)\}/g;
		const matches = Array.from(text.matchAll(orPatternRegex));

		matches.forEach(match => {
			const content = match[1];
			// Skip L:property patterns
			if (!content.startsWith('L:')) {
				// Skip OR patterns (with ,,) - they're handled in generateOrPatternChoices
				if (!content.includes(',,')) {
					keys.push(content.trim());
				}
			}
		});

		return keys;
	}

	/**
	 * Get the merged open-in preference from multiple keys
	 * Returns AND of all preferences (most restrictive)
	 */
	private getMergedOpenInPreference(keys: string[]): OpenInPreference {
		let webviewer = true;
		let external = true;

		for (const key of keys) {
			const pref = this.getOpenInPreference(key);
			webviewer = webviewer && pref.webviewer;
			external = external && pref.external;
		}

		return { webviewer, external };
	}

	/**
	 * Check if a pattern contains OR syntax (,,)
	 * Detects patterns like ${one,,two,,three} and nested patterns like ${${L:prop},,other}
	 */
	private hasOrPattern(text: string): boolean {
		// Use balanced brace matching to properly detect nested patterns
		let i = 0;
		while (i < text.length) {
			if (text[i] === '$' && text[i + 1] === '{') {
				i += 2;
				let braceCount = 1;
				let content = '';

				while (i < text.length && braceCount > 0) {
					if (text[i] === '{') {
						braceCount++;
						content += text[i];
					} else if (text[i] === '}') {
						braceCount--;
						if (braceCount > 0) {
							content += text[i];
						}
					} else {
						content += text[i];
					}
					i++;
				}

				// Check if this pattern contains ,,
				if (content.includes(',,')) {
					return true;
				}
			} else {
				i++;
			}
		}
		return false;
	}

	/**
	 * Generate all possible URLs from OR patterns
	 * Uses ,, (double comma) as the OR separator
	 * For ${one,,two}/${three,,four}, generates 4 URLs with all combinations (2×2)
	 * For ${prefix${one},,alt${two}}, supports prefix/suffix around variables
	 * @returns Array of {label, url, value, keys} objects
	 */
	private generateOrPatternChoices(text: string, sourcePath?: string, isInternalLink: boolean = true): Array<{label: string; url: string; value: string; keys: string[]}> {
		// Find all OR patterns in the text
		// Need to handle nested ${} properly - use a function to extract balanced braces
		const extractBalancedPatterns = (text: string): Array<{match: string; content: string; index: number}> => {
			const patterns: Array<{match: string; content: string; index: number}> = [];
			let i = 0;

			while (i < text.length) {
				// Look for ${
				if (text[i] === '$' && text[i + 1] === '{') {
					const startIndex = i;
					i += 2; // Skip ${
					let braceCount = 1;
					let content = '';

					// Find matching }
					while (i < text.length && braceCount > 0) {
						if (text[i] === '{') {
							braceCount++;
							content += text[i];
						} else if (text[i] === '}') {
							braceCount--;
							if (braceCount > 0) {
								content += text[i];
							}
						} else {
							content += text[i];
						}
						i++;
					}

					if (braceCount === 0) {
						const match = text.substring(startIndex, i);
						patterns.push({match, content, index: startIndex});
					}
				} else {
					i++;
				}
			}

			return patterns;
		};

		const matches = extractBalancedPatterns(text);

		// Find all patterns with OR operator (,,)
		const orMatches = matches.filter(m => m.content.includes(',,'));

		if (orMatches.length === 0) {
			// No OR pattern found, return single choice
			return [{
				label: 'Open',
				url: this.replacePatterns(text, sourcePath, isInternalLink),
				value: '',
				keys: []
			}];
		}

		// Get active replacements to look up values
		const activeReplacements = this.getActiveLinkReplacements();

		// For each OR pattern, split on ,, to get the list of options
		// Treat bare words as ${word} (grammar sugar)
		const allOptionGroups: string[][] = orMatches.map((match) => {
			const content = match.content;
			const splitOptions = content.split(',,');

			const processedOptions = splitOptions.map((opt: string) => {
				const trimmed = opt.trim();

				// If option doesn't contain ${, treat it as a bare variable name
				// Grammar sugar: "one" becomes "${one}"
				if (!trimmed.includes('${')) {
					return `\${${trimmed}}`;
				} else {
					return trimmed;
				}
			});

			return processedOptions;
		});

		// Generate all combinations using cartesian product
		const generateCombinations = (groups: string[][]): string[][] => {
			if (groups.length === 0) return [[]];
			if (groups.length === 1) return groups[0].map(item => [item]);

			const [first, ...rest] = groups;
			const restCombinations = generateCombinations(rest);
			const result: string[][] = [];

			for (const item of first) {
				for (const combination of restCombinations) {
					result.push([item, ...combination]);
				}
			}

			return result;
		};

		const combinations = generateCombinations(allOptionGroups);

		// Generate choices for each combination
		const choices: Array<{label: string; url: string; value: string; keys: string[]}> = [];

		combinations.forEach(combination => {
			// Replace all OR patterns with the corresponding options from this combination
			let processedText = text;

			orMatches.forEach((match, index) => {
				const option = combination[index];

				// Need to escape special regex characters in the pattern
				const escapedPattern = match.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				processedText = processedText.replace(new RegExp(escapedPattern, 'g'), option);
			});

			// Apply normal pattern replacement to the processed text
			// This handles any nested ${VAR} patterns within the options
			const processedUrl = this.replacePatterns(processedText, sourcePath, isInternalLink);

			// Extract dictionary keys from each option in this combination
			// Options are now already wrapped with ${...} due to grammar sugar
			const keysInOption: string[] = [];
			combination.forEach(option => {
				// Extract all ${KEY} patterns from this option
				const keysInThisOption = this.extractKeysFromPattern(option);
				keysInOption.push(...keysInThisOption);
			});

			// Create label from all options in this combination
			const label = combination.join(' + ');

			// Get value for display (use first option's resolved value)
			// combination[0] is already wrapped, so extract the first key and resolve it
			let value = combination[0];
			const firstOptionKeys = this.extractKeysFromPattern(combination[0]);
			if (firstOptionKeys.length > 0) {
				const dictKey = Object.keys(activeReplacements).find(
					k => k.toLowerCase() === firstOptionKeys[0].toLowerCase()
				);
				if (dictKey) {
					value = activeReplacements[dictKey];
				}
			}

			choices.push({
				label: label,
				url: processedUrl,
				value: value,
				keys: keysInOption // All dictionary keys found in this combination's options
			});
		});

		return choices;
	}

	/**
	 * Core pattern replacement method
	 *
	 * Supports two pattern types:
	 * 1. ${KEY} - Looks up in linkReplacements dictionary (case-insensitive)
	 * 2. ${L:property} - Looks up in current note's frontmatter properties (case-insensitive)
	 *
	 * For ${L:property}:
	 * - Accepts any property type (string, number, array, object, etc.)
	 * - Converts to string using String()
	 * - Replaces invalid filename chars (/, \, :) for internal links only
	 *
	 * @param text - The text containing patterns to replace
	 * @param sourcePath - Optional path to the source file (for context)
	 * @param isInternalLink - Whether this is an internal link (affects char replacement)
	 * @returns The text with patterns replaced
	 */
	private replacePatterns(text: string, sourcePath?: string, isInternalLink: boolean = true): string {
		// Reset error flag at start of replacement
		this.hasPropertyError = false;

		// Get filename for warning messages
		let fileName = 'unknown';
		const activeFile = sourcePath
			? this.app.vault.getAbstractFileByPath(sourcePath)
			: this.app.workspace.getActiveFile();
		if (activeFile instanceof TFile) {
			fileName = activeFile.basename;
		}

		const result = text.replace(this.pattern, (match, key) => {
			// Check if this is a note property lookup (L:xxx format)
			if (key.startsWith('L:')) {
				const propertyKey = key.substring(2); // Remove "L:" prefix

				// Get the active file or use sourcePath if provided
				let activeFile = sourcePath
					? this.app.vault.getAbstractFileByPath(sourcePath)
					: this.app.workspace.getActiveFile();

				// Ensure it's a TFile (not a folder) and is a markdown file
				if (!(activeFile instanceof TFile) || activeFile.extension !== 'md') {
					return match; // Keep pattern if no valid markdown file
				}

				// Get the file's metadata
				const metadata = this.app.metadataCache.getFileCache(activeFile);
				if (!metadata?.frontmatter) {
					return match; // Keep pattern if no frontmatter
				}

				// Check if property exists (case-insensitive)
				const actualKey = Object.keys(metadata.frontmatter).find(
					k => k.toLowerCase() === propertyKey.toLowerCase()
				);

				if (!actualKey) {
					new Notice(`⚠️ [${fileName}] Property "${propertyKey}" does not exist in this file.`, 5000);
					this.hasPropertyError = true;
					return ''; // Remove pattern to prevent link errors
				}

				const propertyValue = metadata.frontmatter[actualKey];

				// Convert any property type to string
				let stringValue = String(propertyValue);

				// Replace invalid filename characters only for internal links
				if (isInternalLink) {
					const invalidChars = /[\/\\:]/g;
					stringValue = stringValue.replace(invalidChars, this.settings.invalidCharReplacement);
				}

				return stringValue;
			}

			// Default behavior: look up in active replacements dictionary (case-insensitive)
			const activeReplacements = this.getActiveLinkReplacements();
			const dictKey = Object.keys(activeReplacements).find(
				k => k.toLowerCase() === key.toLowerCase()
			);

			if (dictKey) {
				let value = activeReplacements[dictKey];

				// Replace invalid filename characters only for internal links
				if (isInternalLink) {
					const invalidChars = /[\/\\:]/g;
					value = value.replace(invalidChars, this.settings.invalidCharReplacement);
				}

				return value;
			}

			return match;
		});

		return result;
	}

	async onload() {
		await this.loadSettings();

		// ========================================
		// MONKEY-PATCH: Internal Link Opening
		// ========================================
		// Intercept Obsidian's link opening to apply pattern replacements
		// This handles both [[wikilinks]] and markdown [](links) for internal files
		const originalOpenLinkText = this.app.workspace.openLinkText;

		if (!originalOpenLinkText) {
			return;
		}

		this.app.workspace.openLinkText = async (
			linktext: string,
			sourcePath: string,
			newLeaf?: boolean,
			openViewState?: any
		) => {
			// Check if this link has OR pattern
			if (this.hasOrPattern(linktext)) {
				// Generate all choices
				const choices = this.generateOrPatternChoices(linktext, sourcePath, true);

				// Filter out choices that contain ignored keys (case-insensitive)
				const filteredChoices = choices.filter(choice => {
					return !choice.keys.some(key => this.isKeyIgnored(key));
				});

				// If all choices are filtered out, don't open anything
				if (filteredChoices.length === 0) {
					new Notice('All options for this link are ignored on this device');
					return;
				}

				// If only one choice remains, open it directly without modal
				if (filteredChoices.length === 1) {
					originalOpenLinkText.call(
						this.app.workspace,
						filteredChoices[0].url,
						sourcePath,
						newLeaf,
						openViewState
					);
					return;
				}

				// Show modal to let user choose from filtered options
				const modal = new LinkChoiceModal(this.app, filteredChoices, (chosenUrl) => {
					// Open the chosen URL
					originalOpenLinkText.call(
						this.app.workspace,
						chosenUrl,
						sourcePath,
						newLeaf,
						openViewState
					);
				});
				modal.open();
				return; // Don't proceed with normal link opening
			}

			const processed = this.replacePatterns(linktext, sourcePath);

			// If there was a property error, don't open the link at all
			if (this.hasPropertyError) {
				return; // Cancel link opening
			}

			// Only process if replacement occurred
			if (processed !== linktext) {
				// Call original with processed URL
				// This preserves ALL user choice (new leaf, modifiers, etc.)
				return originalOpenLinkText.call(
					this.app.workspace,
					processed,
					sourcePath,
					newLeaf,
					openViewState
				);
			}

			// Pass through for normal links
			return originalOpenLinkText.call(
				this.app.workspace,
				linktext,
				sourcePath,
				newLeaf,
				openViewState
			);
		};

		// Restore original function on plugin unload
		this.register(() => {
			this.app.workspace.openLinkText = originalOpenLinkText;
		});

		// ========================================
		// EXTERNAL URL HANDLING: Context Menu
		// ========================================
		// Handle right-click on external URLs to provide pattern replacement options
		// Supports credential actions (two-tab opening) for sensitive data
		this.registerEvent(
			this.app.workspace.on('url-menu', (menu, url) => {
				const plugin = this; // Capture plugin instance for callbacks
				// Decode URL to handle encoded characters
				let decodedUrl: string;
				try {
					decodedUrl = decodeURIComponent(url);
				} catch (e) {
					decodedUrl = url; // If decoding fails, use original
				}

				// Check if URL has OR pattern
				const hasOrPattern = plugin.hasOrPattern(decodedUrl);

				// Apply pattern replacements to the URL
				// Note: isInternalLink=false means we don't replace invalid chars (/, \, :)
				const processed = plugin.replacePatterns(decodedUrl, undefined, false);

				// Check if any replacement occurred
				const hasPattern = processed !== decodedUrl || hasOrPattern;

				if (hasPattern) {
					// Check if webviewer plugin is truly enabled
					// Must satisfy ALL conditions:
					// 1. Plugin exists (desktop only - doesn't exist on mobile)
					// 2. Plugin is loaded (_loaded = true)
					// 3. openExternalURLs option is enabled (instance.options.openExternalURLs = true)
					// @ts-ignore - accessing internal API
					const internalPlugins = plugin.app.internalPlugins;
					const webviewerPlugin = internalPlugins?.plugins?.['webviewer'];

					const hasWebviewerOption = !!(
						webviewerPlugin &&
						webviewerPlugin._loaded &&
						webviewerPlugin.instance?.options?.openExternalURLs
					);

					// If OR pattern exists, generate all choices
					if (hasOrPattern) {
						const choices = plugin.generateOrPatternChoices(decodedUrl, undefined, false);

						// Filter out choices that contain ignored keys (case-insensitive)
						const filteredChoices = choices.filter(choice => {
							return !choice.keys.some(key => plugin.isKeyIgnored(key));
						});

						// If all choices are filtered out, don't show menu
						if (filteredChoices.length === 0) {
							return;
						}

						filteredChoices.forEach((choice) => {
							// Get merged preference for all keys in this combination
							const pref = choice.keys.length > 0
								? plugin.getMergedOpenInPreference(choice.keys)
								: { webviewer: true, external: true };

							// Decide what to show based on preference and webviewer availability
							if (hasWebviewerOption && pref.webviewer) {
								// Webviewer is available and preference allows it
								menu.addItem((item) => {
									item.setTitle(`Open in webviewer (${choice.value})`);
									item.setIcon('globe');
									item.onClick(() => {
										const finalUrl = plugin.removeDummyPrefix(choice.url);
										window.open(finalUrl, '_blank');
									});
								});
							}

							// Show external option if:
							// 1. Preference allows external, OR
							// 2. Webviewer is not available (fallback for webviewer-only preference)
							if (pref.external || !hasWebviewerOption) {
								menu.addItem((item) => {
									item.setTitle(`Open externally (${choice.value})`);
									item.setIcon('external-link');
									item.onClick(async () => {
										const finalUrl = plugin.removeDummyPrefix(choice.url);
										const electron = (window as any).require?.('electron');
										if (electron?.shell?.openExternal) {
											try {
												await electron.shell.openExternal(finalUrl);
											} catch (error) {
												console.error('Failed to open external URL:', finalUrl, error);
												new Notice(`Failed to open: ${error.message}`);
											}
										} else {
											window.open(finalUrl, '_blank');
										}
									});
								});
							}
						});
					} else {
						// No OR pattern - original behavior with single menu items
						// Extract keys to check preferences
						const keys = plugin.extractKeysFromPattern(decodedUrl);

						// Check if any keys are ignored on current device (case-insensitive)
						const hasIgnoredKey = keys.some(key => plugin.isKeyIgnored(key));

						// Don't show menu if any key is ignored
						if (hasIgnoredKey) {
							return;
						}

						const mergedPref = keys.length > 0 ? plugin.getMergedOpenInPreference(keys) : { webviewer: true, external: true };

						// Add menu item to open in webviewer (only if webviewer is available and preference allows)
						if (hasWebviewerOption && mergedPref.webviewer) {
							menu.addItem((item) => {
								item.setTitle('Open in webviewer (with injection)');
								item.setIcon('globe');
								item.onClick(() => {
									const finalUrl = plugin.removeDummyPrefix(processed);
									window.open(finalUrl, '_blank');
								});
							});
						}

						// Add menu item to open externally
						// Show external option if:
						// 1. Preference allows external, OR
						// 2. Webviewer is not available (fallback for webviewer-only preference)
						if (mergedPref.external || !hasWebviewerOption) {
							menu.addItem((item) => {
								item.setTitle('Open externally (with injection)');
								item.setIcon('external-link');
								item.onClick(async () => {
									const finalUrl = plugin.removeDummyPrefix(processed);
									const electron = (window as any).require?.('electron');
									if (electron?.shell?.openExternal) {
										try {
											await electron.shell.openExternal(finalUrl);
										} catch (error) {
											console.error('Failed to open external URL:', finalUrl, error);
											new Notice(`Failed to open: ${error.message}`);
										}
									} else {
										window.open(finalUrl, '_blank');
									}
								});
							});
						}
					}
				}
			})
		);

		// ========================================
		// SETTINGS TAB
		// ========================================
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		// Migration: Initialize openInPreferences for existing keys
		if (!this.settings.openInPreferences) {
			this.settings.openInPreferences = {};
		}
		// Ensure all existing keys have an openIn preference (both enabled by default)
		Object.keys(this.settings.defaultLinkReplacements).forEach(key => {
			const pref = this.settings.openInPreferences[key];
			// Migrate old string format to new object format
			if (!pref || typeof pref === 'string') {
				this.settings.openInPreferences[key] = { webviewer: true, external: true };
			}
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/**
 * Settings Tab
 *
 * Provides UI for:
 * 1. Link Replacement Dictionary - Key-value pairs for ${KEY} patterns
 * 2. Invalid Character Replacement - Configurable replacement for ${L:property} patterns
 */
class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		// ========================================
		// SECTION: Device Profile
		// ========================================
		containerEl.createEl('h2', { text: 'Device Profile' });

			const currentVaultPath = this.plugin.getCurrentVaultPath();
			const currentProfile = this.plugin.getCurrentProfile();

			// If no profile exists for this vault, show profile name input
			if (!currentProfile) {
				const profileInfoDiv = containerEl.createDiv();
				profileInfoDiv.setAttribute('style', 'margin-bottom: 20px; padding: 15px; background-color: var(--background-secondary); border-radius: 5px;');

				profileInfoDiv.createEl('p', {
					text: 'No profile found for this vault. Please create a profile name:',
					attr: { style: 'margin: 0 0 10px 0; font-weight: bold;' }
				});

				profileInfoDiv.createEl('p', {
					text: `Vault path: ${currentVaultPath}`,
					attr: { style: 'margin: 0 0 15px 0; font-size: 0.85em; color: var(--text-muted); word-break: break-all;' }
				});

				const inputContainer = profileInfoDiv.createDiv();
				inputContainer.setAttribute('style', 'display: flex; gap: 10px; align-items: center;');

				const profileNameInput = inputContainer.createEl('input', {
					type: 'text',
					placeholder: 'Profile name (max 20 chars)',
					attr: {
						style: 'flex: 1; max-width: 300px;',
						maxlength: '20'
					}
				});

				const createButton = inputContainer.createEl('button', {
					text: 'Create Profile',
					cls: 'mod-cta'
				});

				createButton.addEventListener('click', async () => {
					const profileName = profileNameInput.value.trim();

					// Validate profile name
					if (!profileName) {
						new Notice('Profile name cannot be empty.');
						return;
					}

					if (profileName.length > 20) {
						new Notice('Profile name must be 20 characters or less.');
						return;
					}

					// Create new profile
					const newProfile: DeviceProfile = {
						profileName: profileName,
						vaultPath: currentVaultPath,
						linkReplacements: {}
					};

					this.plugin.settings.deviceProfiles.push(newProfile);
					await this.plugin.saveSettings();

					new Notice(`Profile "${profileName}" created successfully!`);
					this.display(); // Re-render to show the profile
				});
			} else {
				// Show current profile info
				const profileInfoDiv = containerEl.createDiv();
				profileInfoDiv.setAttribute('style', 'margin-bottom: 20px; padding: 15px; background-color: var(--background-secondary); border-radius: 5px;');

				profileInfoDiv.createEl('p', {
					text: `Current Profile: ${currentProfile.profileName}`,
					attr: { style: 'margin: 0 0 5px 0; font-weight: bold; font-size: 1.1em;' }
				});

				profileInfoDiv.createEl('p', {
					text: `Vault path: ${currentVaultPath}`,
					attr: { style: 'margin: 0; font-size: 0.85em; color: var(--text-muted); word-break: break-all;' }
				});
			}

			// Edit Device Profiles link (collapsible section)
			const editLinkContainer = containerEl.createDiv();
			editLinkContainer.setAttribute('style', 'margin: 15px 0; text-align: right;');

			const editLink = editLinkContainer.createEl('a', {
				text: 'Edit Device Profiles',
				attr: {
					href: '#',
					style: 'font-size: 0.9em; color: var(--text-accent); text-decoration: none; cursor: pointer;'
				}
			});

			let isExpanded = false;
			const profilesListContainer = containerEl.createDiv();
			profilesListContainer.setAttribute('style', 'display: none; margin-top: 15px;');

			editLink.addEventListener('click', (e) => {
				e.preventDefault();
				isExpanded = !isExpanded;
				profilesListContainer.style.display = isExpanded ? 'block' : 'none';
				editLink.setText(isExpanded ? 'Hide Device Profiles' : 'Edit Device Profiles');
			});

			// Render device profiles list
			const renderProfilesList = () => {
				profilesListContainer.empty();

				profilesListContainer.createEl('h3', {
					text: 'All Device Profiles',
					attr: { style: 'margin: 15px 0 10px 0;' }
				});

				const profilesContainer = profilesListContainer.createDiv();
				profilesContainer.setAttribute('style', 'overflow-x: auto;');

				this.plugin.settings.deviceProfiles.forEach((profile) => {
					const profileRow = profilesContainer.createDiv();
					profileRow.setAttribute('style', 'display: flex; align-items: center; gap: 5px; margin-bottom: 5px; flex-wrap: nowrap; min-width: fit-content;');

					const nameInput = profileRow.createEl('input', {
						type: 'text',
						value: profile.profileName,
						placeholder: 'Profile name',
						attr: {
							style: 'width: 150px;',
							maxlength: '20'
						}
					});

					const pathInput = profileRow.createEl('input', {
						type: 'text',
						value: profile.vaultPath,
						placeholder: 'Vault path',
						attr: { style: 'flex: 1;' }
					});

					// Auto-save name changes on blur
					nameInput.addEventListener('blur', async () => {
						const newName = nameInput.value.trim();
						if (!newName) {
							new Notice('Profile name cannot be empty.');
							nameInput.value = profile.profileName;
							return;
						}
						if (newName.length > 20) {
							new Notice('Profile name must be 20 characters or less.');
							nameInput.value = profile.profileName;
							return;
						}
						if (newName !== profile.profileName) {
							profile.profileName = newName;
							await this.plugin.saveSettings();
							this.display(); // Re-render to update current profile display
						}
					});

					// Auto-save path changes on blur
					pathInput.addEventListener('blur', async () => {
						const newPath = pathInput.value.trim();
						if (!newPath) {
							new Notice('Vault path cannot be empty.');
							pathInput.value = profile.vaultPath;
							return;
						}
						if (newPath !== profile.vaultPath) {
							profile.vaultPath = newPath;
							await this.plugin.saveSettings();
							this.display(); // Re-render to update current profile display
						}
					});

					const deleteButton = profileRow.createEl('button', {
						cls: 'mod-warning',
						attr: {
							title: 'Delete profile',
							style: 'width: 30px; height: 30px; padding: 0; display: flex; align-items: center; justify-content: center;'
						}
					});
					deleteButton.innerHTML = '✕';
					deleteButton.addEventListener('click', async () => {
						const index = this.plugin.settings.deviceProfiles.indexOf(profile);
						if (index > -1) {
							this.plugin.settings.deviceProfiles.splice(index, 1);
							await this.plugin.saveSettings();
							renderProfilesList();
							this.display(); // Re-render in case we deleted the current profile
						}
					});
				});

				// Add new profile button
				const addDiv = profilesContainer.createDiv();
				addDiv.setAttribute('style', 'display: flex; align-items: center; gap: 5px; margin-top: 10px; flex-wrap: nowrap; min-width: fit-content;');

				const newNameInput = addDiv.createEl('input', {
					type: 'text',
					placeholder: 'Profile name',
					attr: {
						style: 'width: 150px;',
						maxlength: '20'
					}
				});

				const newPathInput = addDiv.createEl('input', {
					type: 'text',
					placeholder: 'Vault path',
					attr: { style: 'flex: 1;' }
				});

				const addButton = addDiv.createEl('button', {
					cls: 'mod-cta',
					attr: {
						title: 'Add profile',
						style: 'width: 30px; height: 30px; padding: 0; display: flex; align-items: center; justify-content: center;'
					}
				});
				addButton.innerHTML = '+';
				addButton.addEventListener('click', async () => {
					const name = newNameInput.value.trim();
					const path = newPathInput.value.trim();

					if (!name) {
						new Notice('Profile name cannot be empty.');
						return;
					}
					if (name.length > 20) {
						new Notice('Profile name must be 20 characters or less.');
						return;
					}
					if (!path) {
						new Notice('Vault path cannot be empty.');
						return;
					}

					// Check for duplicate path
					const existing = this.plugin.settings.deviceProfiles.find(p => p.vaultPath === path);
					if (existing) {
						new Notice('A profile with this vault path already exists.');
						return;
					}

					const newProfile: DeviceProfile = {
						profileName: name,
						vaultPath: path,
						linkReplacements: {}
					};

					this.plugin.settings.deviceProfiles.push(newProfile);
					await this.plugin.saveSettings();

					newNameInput.value = '';
					newPathInput.value = '';
					renderProfilesList();
					this.display(); // Re-render to update UI
				});
			};

			renderProfilesList();

		containerEl.createEl('hr', { attr: { style: 'margin: 20px 0; border: none; border-top: 1px solid var(--background-modifier-border);' } });

		// ========================================
		// SECTION: Link Replacement Dictionary
		// ========================================

		const headerContainer = containerEl.createDiv();
		headerContainer.setAttribute('style', 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;');

		headerContainer.createEl('h2', { text: 'Link Replacement Dictionary', attr: { style: 'margin: 0;' } });

		const editDictionaryLink = headerContainer.createEl('a', {
			text: 'Edit Link Replacement Dictionary',
			attr: {
				href: '#',
				style: 'font-size: 0.9em; color: var(--text-accent); text-decoration: none; cursor: pointer;'
			}
		});

		containerEl.createEl('p', { text: 'Add key-value pairs to replace ${KEY} patterns in links with their corresponding values.' });

		let isEditMode = false;

		// Container for rendering the list of replacements
		const replacementsContainer = containerEl.createDiv('link-replacements-container');
		replacementsContainer.setAttribute('style', 'overflow-x: auto;');

		editDictionaryLink.addEventListener('click', (e) => {
			e.preventDefault();
			isEditMode = !isEditMode;
			editDictionaryLink.setText(isEditMode ? 'Hide Editor' : 'Edit Link Replacement Dictionary');
			renderReplacements();
		});

		const renderReplacements = () => {
			replacementsContainer.empty();

			if (!isEditMode) {
				// Display-only table view
				const activeReplacements = this.plugin.getActiveLinkReplacements();
				const keys = Object.keys(activeReplacements).sort();

				if (keys.length === 0) {
					replacementsContainer.createEl('p', {
						text: 'No replacements defined yet. Click "Edit Link Replacement Dictionary" to add some.',
						attr: { style: 'color: var(--text-muted); font-style: italic;' }
					});
					return;
				}

				// Create table
				const table = replacementsContainer.createEl('table', {
					attr: { style: 'width: 100%; border-collapse: collapse; margin-top: 10px;' }
				});

				// Table header
				const thead = table.createEl('thead');
				const headerRow = thead.createEl('tr');
				headerRow.createEl('th', {
					text: 'Key',
					attr: { style: 'text-align: left; padding: 8px; border-bottom: 2px solid var(--background-modifier-border); font-weight: bold;' }
				});
				headerRow.createEl('th', {
					text: 'Value',
					attr: { style: 'text-align: left; padding: 8px; border-bottom: 2px solid var(--background-modifier-border); font-weight: bold;' }
				});

				// Table body
				const tbody = table.createEl('tbody');
				keys.forEach((key, index) => {
					const row = tbody.createEl('tr');
					const isLastRow = index === keys.length - 1;
					const borderStyle = isLastRow ? 'padding: 8px;' : 'padding: 8px; border-bottom: 1px solid var(--background-modifier-border);';

					row.createEl('td', {
						text: key,
						attr: { style: borderStyle }
					});
					row.createEl('td', {
						text: activeReplacements[key],
						attr: { style: borderStyle }
					});
				});

				return;
			}

			// Edit mode - show the full editor
			replacementsContainer.empty();

			// Collect all unique keys from defaults
			const allKeys = new Set<string>();
			Object.keys(this.plugin.settings.defaultLinkReplacements).forEach(k => allKeys.add(k));

			const currentProfile = this.plugin.getCurrentProfile();

			// Render each key with its default and overrides
			Array.from(allKeys).sort().forEach((key) => {
				const defaultValue = this.plugin.settings.defaultLinkReplacements[key];

				// Default row
				const defaultRow = replacementsContainer.createDiv('replacement-item');
				defaultRow.setAttribute('style', 'display: flex; align-items: center; gap: 5px; margin-bottom: 3px; flex-wrap: nowrap; min-width: fit-content;');

				// Key input (editable)
				const keyInput = defaultRow.createEl('input', {
					type: 'text',
					placeholder: 'Key',
					value: key,
					cls: 'replacement-key',
					attr: {
						style: 'width: 100px;'
					}
				});

				// Auto-save key changes on blur
				keyInput.addEventListener('blur', async () => {
					const newKey = keyInput.value.trim();

					// Don't proceed if key hasn't changed
					if (newKey === key) {
						return;
					}

					// Validate: key cannot be empty
					if (!newKey) {
						new Notice('Key cannot be empty.');
						keyInput.value = key; // Revert to old value
						return;
					}

					// Validate: key cannot contain ':' or ','
					if (newKey.includes(':')) {
						new Notice('Key cannot contain ":" character. This is reserved for special patterns like ${L:property}.');
						keyInput.value = key; // Revert to old value
						return;
					}
					if (newKey.includes(',')) {
						new Notice('Key cannot contain "," character. This is reserved for OR patterns like ${one,,two}.');
						keyInput.value = key; // Revert to old value
						return;
					}

					// Check if new key already exists (case-insensitive)
					const existingKey = Object.keys(this.plugin.settings.defaultLinkReplacements).find(
						k => k.toLowerCase() === newKey.toLowerCase() && k !== key
					);
					if (existingKey) {
						new Notice(`Key "${existingKey}" already exists.`);
						keyInput.value = key; // Revert to old value
						return;
					}

					// Rename the key in defaultLinkReplacements
					const value = this.plugin.settings.defaultLinkReplacements[key];
					delete this.plugin.settings.defaultLinkReplacements[key];
					this.plugin.settings.defaultLinkReplacements[newKey] = value;

					// Rename in all profile overrides
					this.plugin.settings.deviceProfiles.forEach(profile => {
						if (key in profile.linkReplacements) {
							const overrideValue = profile.linkReplacements[key];
							delete profile.linkReplacements[key];
							profile.linkReplacements[newKey] = overrideValue;
						}
					});

					// Rename in openInPreferences
					if (key in this.plugin.settings.openInPreferences) {
						const pref = this.plugin.settings.openInPreferences[key];
						delete this.plugin.settings.openInPreferences[key];
						this.plugin.settings.openInPreferences[newKey] = pref;
					}

					await this.plugin.saveSettings();
					renderReplacements(); // Re-render to show updated key
				});

				// Profile label
				const profileLabel = defaultRow.createEl('span', {
					text: 'Default',
					attr: { style: 'min-width: 80px; font-size: 0.9em; color: var(--text-muted);' }
				});

				// Value input
				const valueInput = defaultRow.createEl('input', {
					type: 'text',
					placeholder: 'Value',
					value: defaultValue,
					cls: 'replacement-value',
					attr: { style: 'flex: 1; min-width: 250px; max-width: 300px;' }
				});


				// Auto-save value changes on blur
				valueInput.addEventListener('blur', async () => {
					const newValue = valueInput.value; // Don't trim - allow blank values
					if (newValue !== defaultValue) {
						this.plugin.settings.defaultLinkReplacements[key] = newValue;
						await this.plugin.saveSettings();
					}
				});

				// Half-pill toggle buttons for Open In preference
				const currentPref = this.plugin.getOpenInPreference(key);
				const pillGroup = defaultRow.createDiv();
				pillGroup.setAttribute('style', 'display: flex; gap: 0;');

				const createToggleButton = (emoji: string, field: 'webviewer' | 'external', position: 'left' | 'right') => {
					const isSelected = currentPref[field];
					const button = pillGroup.createEl('button', {
						text: emoji,
						cls: 'clickable-icon',
						attr: {
							type: 'button',
							'aria-label': field === 'webviewer' ? 'Toggle webviewer' : 'Toggle external browser',
							style: `
								padding: 6px 14px;
								font-size: 1.1em;
								border: 1.5px solid var(--background-modifier-border);
								background-color: ${isSelected ? 'var(--interactive-accent)' : 'transparent'};
								color: ${isSelected ? 'var(--text-on-accent)' : 'var(--text-muted)'};
								cursor: pointer;
								transition: all 0.15s ease;
								${position === 'left' ? 'border-radius: 14px 0 0 14px; border-right: none;' : 'border-radius: 0 14px 14px 0; margin-left: -1px;'}
								${isSelected ? 'box-shadow: inset 0 0 0 1px var(--interactive-accent);' : ''}
							`.trim().replace(/\s+/g, ' ')
						}
					});

					button.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();

						// Validate: At least one option must be enabled
						const currentPref = this.plugin.settings.openInPreferences[key];
						const otherField = field === 'webviewer' ? 'external' : 'webviewer';

						// If trying to disable the only enabled option, prevent it
						if (currentPref[field] && !currentPref[otherField]) {
							new Notice('At least one option must be enabled (webviewer or external)');
							return;
						}

						this.plugin.settings.openInPreferences[key][field] = !this.plugin.settings.openInPreferences[key][field];
						await this.plugin.saveSettings();
						renderReplacements();
					};

					button.addEventListener('mouseenter', () => {
						if (!isSelected) {
							button.style.backgroundColor = 'var(--background-modifier-hover)';
						}
					});

					button.addEventListener('mouseleave', () => {
						if (!isSelected) {
							button.style.backgroundColor = 'transparent';
						}
					});

					return button;
				};

				createToggleButton('🌐', 'webviewer', 'left');
				createToggleButton('🔗', 'external', 'right');

				// Add Override button - check if there are profiles without overrides
				const profilesWithoutOverride = this.plugin.settings.deviceProfiles.filter(p => !(key in p.linkReplacements));

				if (profilesWithoutOverride.length > 0) {
					const addOverrideButton = defaultRow.createEl('button', {
						text: '+ Override',
						cls: 'mod-cta',
						attr: {
							title: 'Add profile-specific override',
							style: 'padding: 2px 8px; font-size: 0.85em;'
						}
					});
					addOverrideButton.addEventListener('click', async () => {
						// If only one profile without override, add it directly
						if (profilesWithoutOverride.length === 1) {
							const profile = profilesWithoutOverride[0];
							profile.linkReplacements[key] = defaultValue;
							await this.plugin.saveSettings();
							renderReplacements();
						} else {
							// Multiple profiles without overrides
							// Prefer current profile if available, otherwise choose first non-current profile
							const targetProfile = profilesWithoutOverride.find(p => p.vaultPath === currentProfile?.vaultPath) || profilesWithoutOverride[0];
							targetProfile.linkReplacements[key] = defaultValue;
							await this.plugin.saveSettings();
							renderReplacements();
						}
					});
				} else if (this.plugin.settings.deviceProfiles.length > 0) {
					// All profiles have overrides - gray out the button
					const addOverrideButton = defaultRow.createEl('button', {
						text: '+ Override',
						cls: 'mod-cta',
						attr: {
							title: 'All profiles already have overrides',
							style: 'padding: 2px 8px; font-size: 0.85em; opacity: 0.4; cursor: not-allowed;',
							disabled: 'disabled'
						}
					});
				}

				// Check if there are any overrides for this key
				const hasOverrides = this.plugin.settings.deviceProfiles.some(p => key in p.linkReplacements);

				// Add show/hide toggle button for overrides if they exist (before delete button)
				if (hasOverrides) {
					const toggleButton = defaultRow.createEl('button', {
						text: '▼',
						cls: 'mod-muted',
						attr: {
							title: 'Toggle overrides',
							style: 'padding: 2px 8px; font-size: 0.85em;'
						}
					});

					// Container for all override rows
					const overridesContainer = replacementsContainer.createDiv('overrides-container');
					overridesContainer.setAttribute('style', 'display: block;'); // Default: visible

					let isOverridesVisible = true;

					toggleButton.addEventListener('click', () => {
						isOverridesVisible = !isOverridesVisible;
						overridesContainer.style.display = isOverridesVisible ? 'block' : 'none';
						toggleButton.setText(isOverridesVisible ? '▼' : '▶');
					});

					// Render override rows for ALL profiles that have an override for this key
					this.plugin.settings.deviceProfiles.forEach((profile) => {
						if (key in profile.linkReplacements) {
							const overrideRow = overridesContainer.createDiv('replacement-item-override');
							overrideRow.setAttribute('style', 'display: flex; align-items: center; gap: 5px; margin-bottom: 5px; flex-wrap: nowrap; min-width: fit-content;');

						// Empty space for key alignment (same width as key input)
						const keySpace = overrideRow.createEl('span', {
							attr: { style: 'width: 150px;' }
						});

						// Profile dropdown
						const profileDropdown = overrideRow.createEl('select', {
							cls: 'dropdown',
							attr: { style: 'width: 150px; font-size: 0.9em;' }
						});

						// Populate dropdown with all profiles
						this.plugin.settings.deviceProfiles.forEach((p) => {
							const option = profileDropdown.createEl('option', {
								value: p.vaultPath,
								text: p.profileName
							});
							if (p.vaultPath === profile.vaultPath) {
								option.selected = true;
							}
						});

						// Handle profile change
						profileDropdown.addEventListener('change', async () => {
							const newVaultPath = profileDropdown.value;
							const newProfile = this.plugin.settings.deviceProfiles.find(p => p.vaultPath === newVaultPath);

							if (!newProfile) return;

							// Check if new profile already has an override for this key
							if (key in newProfile.linkReplacements) {
								new Notice(`Profile "${newProfile.profileName}" already has an override for "${key}".`);
								profileDropdown.value = profile.vaultPath; // Revert dropdown
								return;
							}

							// Move override from old profile to new profile
							const overrideValue = profile.linkReplacements[key];
							delete profile.linkReplacements[key];
							newProfile.linkReplacements[key] = overrideValue;

							await this.plugin.saveSettings();
							renderReplacements();
						});

						// Check if this override is marked as ignored
						const isIgnored = profile.linkReplacements[key] === '@@IGNORE@@';

						// Ignored toggle button
						const ignoredButton = overrideRow.createEl('button', {
							text: 'Ignored',
							cls: isIgnored ? 'mod-warning' : 'mod-muted',
							attr: {
								title: isIgnored ? 'Currently ignored on this device - click to un-ignore' : 'Click to ignore this key on this device',
								style: `padding: 2px 8px; font-size: 0.85em; ${isIgnored ? 'font-weight: bold;' : 'opacity: 0.6;'}`
							}
						});

						ignoredButton.addEventListener('click', async () => {
							if (profile.linkReplacements[key] === '@@IGNORE@@') {
								// Un-ignore: set to default value
								profile.linkReplacements[key] = defaultValue;
							} else {
								// Ignore: set to special marker
								profile.linkReplacements[key] = '@@IGNORE@@';
							}
							await this.plugin.saveSettings();
							renderReplacements();
						});

						// Override value input (disabled if ignored)
						const overrideValueInput = overrideRow.createEl('input', {
							type: 'text',
							placeholder: isIgnored ? '(ignored)' : 'Override value',
							value: isIgnored ? '' : profile.linkReplacements[key],
							cls: 'replacement-value',
							attr: {
								style: `flex: 1; min-width: 250px; ${isIgnored ? 'opacity: 0.4;' : ''}`,
								...(isIgnored ? { disabled: 'disabled' } : {})
							}
						});

						// Auto-save override value changes
						overrideValueInput.addEventListener('blur', async () => {
							if (!isIgnored) {
								const newValue = overrideValueInput.value; // Don't trim - allow blank values
								profile.linkReplacements[key] = newValue;
								await this.plugin.saveSettings();
							}
						});

						// Delete override button (only deletes this override, not the default)
						const deleteOverrideButton = overrideRow.createEl('button', {
							cls: 'mod-warning',
							attr: {
								title: 'Delete override (keeps default)',
								style: 'width: 30px; height: 30px; padding: 0; display: flex; align-items: center; justify-content: center;'
							}
						});
						deleteOverrideButton.innerHTML = '✕';
						deleteOverrideButton.addEventListener('click', async () => {
							delete profile.linkReplacements[key];
							await this.plugin.saveSettings();
							renderReplacements();
						});
						}
					});
				}

				// Delete button (deletes default and all overrides for this key)
				const deleteButton = defaultRow.createEl('button', {
					cls: 'mod-warning',
					attr: {
						title: 'Delete key (including all overrides)',
						style: 'width: 30px; height: 30px; padding: 0; display: flex; align-items: center; justify-content: center;'
					}
				});
				deleteButton.innerHTML = '✕';
				deleteButton.addEventListener('click', async () => {
					delete this.plugin.settings.defaultLinkReplacements[key];
					// Also delete from all profiles
					this.plugin.settings.deviceProfiles.forEach(p => {
						delete p.linkReplacements[key];
					});
					// Delete openIn preference
					delete this.plugin.settings.openInPreferences[key];
					await this.plugin.saveSettings();
					renderReplacements();
				});
			});

			// Add new replacement section (always adds to defaults)
			const addDiv = replacementsContainer.createDiv('add-replacement');
			addDiv.setAttribute('style', 'display: flex; align-items: center; gap: 5px; margin-top: 10px; flex-wrap: nowrap; min-width: fit-content;');

			const newKeyInput = addDiv.createEl('input', {
				type: 'text',
				placeholder: 'Key',
				cls: 'replacement-key',
				attr: { style: 'width: 100px;' }
			});

			// Label showing this adds to defaults
			const defaultLabel = addDiv.createEl('span', {
				text: 'Default',
				attr: { style: 'min-width: 80px; font-size: 0.9em; color: var(--text-muted);' }
			});

			const newValueInput = addDiv.createEl('input', {
				type: 'text',
				placeholder: 'Value',
				cls: 'replacement-value',
				attr: { style: 'flex: 1; min-width: 250px;' }
			});

			const addButton = addDiv.createEl('button', {
				cls: 'mod-cta',
				attr: {
					title: 'Add',
					style: 'width: 30px; height: 30px; padding: 0; display: flex; align-items: center; justify-content: center;'
				}
			});
			addButton.innerHTML = '+';
			addButton.addEventListener('click', async () => {
				const key = newKeyInput.value.trim();
				const value = newValueInput.value; // Don't trim value - allow blank values

				// Validate: key cannot be empty
				if (!key) {
					new Notice('Key cannot be empty.');
					return;
				}

				// Validate: key cannot contain ':' or ','
				if (key.includes(':')) {
					new Notice('Key cannot contain ":" character. This is reserved for special patterns like ${L:property}.');
					return;
				}
				if (key.includes(',')) {
					new Notice('Key cannot contain "," character. This is reserved for OR patterns like ${one,,two}.');
					return;
				}

				// Allow blank values - store the value as-is
				this.plugin.settings.defaultLinkReplacements[key] = value;
				// Initialize openIn preference (both enabled by default)
				if (!this.plugin.settings.openInPreferences[key]) {
					this.plugin.settings.openInPreferences[key] = { webviewer: true, external: true };
				}
				await this.plugin.saveSettings();
				// Clear inputs
				newKeyInput.value = '';
				newValueInput.value = '';
				renderReplacements();
			});
		};

		renderReplacements();

		// ========================================
		// SECTION: Miscellaneous
		// ========================================

		containerEl.createEl('h2', { text: 'Miscellaneous', attr: { style: 'margin-top: 30px;' } });

		new Setting(containerEl)
			.setName('Invalid character replacement')
			.setDesc('Character to replace invalid filename characters (/, \\, :) in pattern values for internal links. Applies to both ${KEY} and ${L:property} patterns. Default is space.')
			.addText(text => text
				.setPlaceholder(' ')
				.setValue(this.plugin.settings.invalidCharReplacement)
				.onChange(async (value) => {
					// Use space if empty
					this.plugin.settings.invalidCharReplacement = value || ' ';
					await this.plugin.saveSettings();
				}));

		// Author and Support section
		createAuthorSupportSection(containerEl, 'https://github.com/ctrl-alt-delete-8/Obsidian-Link-Injection-Redirect');
	}
}

/**
 * Reusable function to create author and support section with buttons
 * @param containerEl - The container element to append the section to
 * @param githubRepoUrl - The GitHub repository URL
 */
function createAuthorSupportSection(containerEl: HTMLElement, githubRepoUrl: string) {
	// Author and Support section
	containerEl.createEl('hr', { attr: { style: 'margin: 30px 0 20px 0; border: none; border-top: 1px solid var(--background-modifier-border);' } });

	const authorSection = containerEl.createDiv();
	authorSection.setAttribute('style', 'text-align: center; margin: 15px 0;');

	authorSection.createEl('p', {
		text: 'Created by @tinkerer-ctrl-alt-del',
		attr: { style: 'margin: 5px 0; font-weight: bold;' }
	});

	authorSection.createEl('p', {
		text: 'Have questions, found a bug, or want to request a feature? Join the Discord server!',
		attr: { style: 'margin: 5px 0; color: var(--text-muted);' }
	});

	const buttonsContainer = containerEl.createDiv();
	buttonsContainer.setAttribute('style', 'text-align: center; margin: 20px 0; display: flex; gap: 15px; justify-content: center; flex-wrap: wrap;');

	// Discord button
	const discordButton = buttonsContainer.createEl('a', {
		text: '💬 Join Discord',
		href: 'https://discord.com/invite/bXMpCTBMcg',
		attr: {
			target: '_blank',
			style: 'display: inline-block; padding: 10px 20px; background-color: #5865F2; color: #FFFFFF; text-decoration: none; border-radius: 5px; font-weight: bold; border: 2px solid #4752C4; transition: opacity 0.2s;'
		}
	});

	discordButton.addEventListener('mouseenter', () => {
		discordButton.style.opacity = '0.8';
	});

	discordButton.addEventListener('mouseleave', () => {
		discordButton.style.opacity = '1';
	});

	// Buy Me a Coffee button
	const coffeeButton = buttonsContainer.createEl('a', {
		text: 'Buy me a coffee',
		href: 'https://www.buymeacoffee.com/tinkerer.ctrl.alt.del',
		attr: {
			target: '_blank',
			style: 'display: inline-block; padding: 10px 20px; background-color: #FFDD00; color: #000000; text-decoration: none; border-radius: 5px; font-weight: bold; border: 2px solid #000000; transition: opacity 0.2s;'
		}
	});

	coffeeButton.addEventListener('mouseenter', () => {
		coffeeButton.style.opacity = '0.8';
	});

	coffeeButton.addEventListener('mouseleave', () => {
		coffeeButton.style.opacity = '1';
	});

	// GitHub repo button
	const githubButton = buttonsContainer.createEl('a', {
		text: 'GitHub repo',
		href: githubRepoUrl,
		attr: {
			target: '_blank',
			style: 'display: inline-block; padding: 10px 20px; background-color: #24292e; color: #FFFFFF; text-decoration: none; border-radius: 5px; font-weight: bold; border: 2px solid #1b1f23; transition: opacity 0.2s;'
		}
	});

	githubButton.addEventListener('mouseenter', () => {
		githubButton.style.opacity = '0.8';
	});

	githubButton.addEventListener('mouseleave', () => {
		githubButton.style.opacity = '1';
	});
}
