import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

/**
 * Link Injection Plugin Settings
 *
 * This plugin provides:
 * 1. Link pattern replacement: ${KEY} for dictionary values, ${L:property} for note properties
 */
interface MyPluginSettings {
	// Link Replacement Dictionary
	linkReplacements: Record<string, string>; // Key-value pairs for ${KEY} pattern replacement

	// Character Replacement for ${L:property} patterns
	invalidCharReplacement: string; // Character to replace /, \, : in property values (for internal links only)
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	linkReplacements: {}, // Empty dictionary by default
	invalidCharReplacement: ' ' // Replace invalid chars with space by default
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

			// Default behavior: look up in settings dictionary (case-insensitive)
			const dictKey = Object.keys(this.settings.linkReplacements).find(
				k => k.toLowerCase() === key.toLowerCase()
			);

			if (dictKey) {
				let value = this.settings.linkReplacements[dictKey];

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

				// Apply pattern replacements to the URL
				// Note: isInternalLink=false means we don't replace invalid chars (/, \, :)
				const processed = plugin.replacePatterns(decodedUrl, undefined, false);

				// Check if any replacement occurred
				const hasPattern = processed !== decodedUrl;

				if (hasPattern) {
					let hasWebviewerOption = false;
					const menuItems = (menu as any).items || [];

					// Scan menu items to check for webviewer option and hide default items
					for (let i = 0; i < menuItems.length; i++) {
						const item = menuItems[i];
						const title = item?.titleEl?.textContent || item?.title || '';
						const lowerTitle = title.toLowerCase();

						// Check if this is a webviewer option
						if (lowerTitle.includes('webviewer') || lowerTitle.includes('web viewer')) {
							hasWebviewerOption = true;
							if (item.dom) {
								item.dom.style.display = 'none';
							}
						}
						// Check if this is a default open link item
						else if (
							lowerTitle.includes('open link') ||
							lowerTitle.includes('default browser') ||
							lowerTitle === 'open' ||
							(lowerTitle.startsWith('open') && !lowerTitle.includes('injection'))
						) {
							if (item.dom) {
								item.dom.style.display = 'none';
							}
						}
					}

					const menuEl = (menu as any).dom;

					// Add menu item to open in webviewer (only if original menu has it)
					if (hasWebviewerOption) {
						menu.addItem((item) => {
							item.setTitle('Open in webviewer (with injection)');
							item.setIcon('globe');
							item.onClick(() => {
								window.open(processed, '_blank');
							});
						});

						// Move this item to the top
						if (menuEl && menuEl.firstChild && menuItems.length > 0) {
							const lastItem = menuItems[menuItems.length - 1];
							if (lastItem.dom) {
								menuEl.insertBefore(lastItem.dom, menuEl.firstChild);
							}
						}
					}

					// Add menu item to open externally
					menu.addItem((item) => {
						item.setTitle('Open externally (with injection)');
						item.setIcon('external-link');
						item.onClick(() => {
							const electron = (window as any).require?.('electron');
							if (electron?.shell?.openExternal) {
								electron.shell.openExternal(processed);
							} else {
								window.open(processed, '_blank');
							}
						});
					});

					// Move this item to the top
					if (menuEl && menuEl.firstChild && menuItems.length > 0) {
						const lastItem = menuItems[menuItems.length - 1];
						if (lastItem.dom) {
							menuEl.insertBefore(lastItem.dom, menuEl.firstChild);
						}
					}

					// Add separator after our items
					menu.addSeparator();
					if (menuEl && menuItems.length > 0) {
						const lastItem = menuItems[menuItems.length - 1];
						if (lastItem.dom) {
							menuEl.insertBefore(lastItem.dom, menuEl.children[hasWebviewerOption ? 2 : 1]);
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
		// SECTION: Settings
		// ========================================

		new Setting(containerEl)
			.setName('Invalid character replacement')
			.setDesc('Character to replace invalid filename characters (/, \\, :) in ${L:property} values. Default is space.')
			.addText(text => text
				.setPlaceholder(' ')
				.setValue(this.plugin.settings.invalidCharReplacement)
				.onChange(async (value) => {
					// Use space if empty
					this.plugin.settings.invalidCharReplacement = value || ' ';
					await this.plugin.saveSettings();
				}));

		// ========================================
		// SECTION: Link Replacement Dictionary
		// ========================================

		containerEl.createEl('h2', { text: 'Link Replacement Dictionary' });
		containerEl.createEl('p', { text: 'Add key-value pairs to replace ${KEY} patterns in links with their corresponding values.' });

		// Container for rendering the list of replacements
		const replacementsContainer = containerEl.createDiv('link-replacements-container');
		
		const renderReplacements = () => {
			replacementsContainer.empty();

			const entries = Object.entries(this.plugin.settings.linkReplacements);

			entries.forEach(([key, value]) => {
				const replacementDiv = replacementsContainer.createDiv('replacement-item');
				replacementDiv.setAttribute('style', 'display: flex; align-items: center; gap: 5px; margin-bottom: 5px;');

				const keyInput = replacementDiv.createEl('input', {
					type: 'text',
					placeholder: 'Key',
					value: key,
					cls: 'replacement-key',
					attr: { style: 'width: 150px;' }
				});

				// Auto-save key changes on blur
				keyInput.addEventListener('blur', async () => {
					const newKey = keyInput.value.trim();

					// Validate: key cannot contain ':'
					if (newKey && newKey.includes(':')) {
						new Notice('Key cannot contain ":" character. This is reserved for special patterns like ${L:property}.');
						keyInput.value = key; // Restore original value
						return;
					}

					// Save if key changed
					if (newKey && newKey !== key) {
						delete this.plugin.settings.linkReplacements[key];
						this.plugin.settings.linkReplacements[newKey] = value;
						await this.plugin.saveSettings();

						// Need to re-render because key changed
						renderReplacements();
					}
				});

				const valueInput = replacementDiv.createEl('input', {
					type: 'text',
					placeholder: 'Value',
					value: value,
					cls: 'replacement-value',
					attr: { style: 'width: 300px;' }
				});

				// Auto-save on blur
				valueInput.addEventListener('blur', async () => {
					const newValue = valueInput.value.trim();

					// Save if value changed
					if (newValue && newValue !== value) {
						this.plugin.settings.linkReplacements[key] = newValue;
						await this.plugin.saveSettings();
					}
				});

				const deleteButton = replacementDiv.createEl('button', {
					cls: 'mod-warning',
					attr: {
						title: 'Delete',
						style: 'width: 30px; height: 30px; padding: 0; display: flex; align-items: center; justify-content: center;'
					}
				});
				deleteButton.innerHTML = '✕'; // X icon
				deleteButton.addEventListener('click', async () => {
					delete this.plugin.settings.linkReplacements[key];
					await this.plugin.saveSettings();
					renderReplacements();
				});
			});
			
			// Add new replacement button
			const addDiv = replacementsContainer.createDiv('add-replacement');
			addDiv.setAttribute('style', 'display: flex; align-items: center; gap: 5px; margin-top: 10px;');
			
			const newKeyInput = addDiv.createEl('input', {
				type: 'text',
				placeholder: 'Key (e.g., PASSWORD)',
				cls: 'replacement-key',
				attr: { style: 'width: 150px;' }
			});
			
			const newValueInput = addDiv.createEl('input', {
				type: 'text',
				placeholder: 'Value (e.g., mypassword123)',
				cls: 'replacement-value',
				attr: { style: 'width: 300px;' }
			});
			
			const addButton = addDiv.createEl('button', { 
				cls: 'mod-cta',
				attr: { 
					title: 'Add',
					style: 'width: 30px; height: 30px; padding: 0; display: flex; align-items: center; justify-content: center;'
				}
			});
			addButton.innerHTML = '+'; // Plus icon
			addButton.addEventListener('click', async () => {
				const key = newKeyInput.value.trim();
				const value = newValueInput.value.trim();

				// Validate: key cannot contain ':'
				if (key && key.includes(':')) {
					new Notice('Key cannot contain ":" character. This is reserved for special patterns like ${L:property}.');
					return;
				}

				if (key && value) {
					this.plugin.settings.linkReplacements[key] = value;
					await this.plugin.saveSettings();
					// Clear inputs
					newKeyInput.value = '';
					newValueInput.value = '';
					renderReplacements();
				}
			});
		};

		renderReplacements();

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
