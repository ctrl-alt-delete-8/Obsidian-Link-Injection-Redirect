# Link Injection Redirect

Make your Obsidian links smarter with dynamic variables and flexible routing options. Perfect for multi-device vaults, URL schemes, and context-aware workflows.

## Table of Contents

- [Installation](#installation)
- [Getting Started](#getting-started)
  - [Do You Need Device Profiles?](#do-you-need-device-profiles)
  - [Setting Up Your First Variable](#setting-up-your-first-variable)
  - [Understanding Link Types](#understanding-link-types)
- [Basic Usage](#basic-usage)
  - [Dictionary Variables](#dictionary-variables)
  - [Note Properties](#note-properties)
  - [Opening External Links](#opening-external-links)
  - [Opening Internal Links](#opening-internal-links)
- [Advanced Features](#advanced-features)
  - [OR Patterns](#or-patterns)
  - [Managing Menu Options](#managing-menu-options)
  - [Device Profiles](#device-profiles)
- [Real-World Examples](#real-world-examples)
- [Reference](#reference)
- [Troubleshooting](#troubleshooting)

---

## Installation

### From Obsidian Community Plugins (Recommended)

1. Open Settings → Community plugins
2. Click Browse and search for "Link Injection Redirect"
3. Click Install, then Enable

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ctrl-alt-delete-8/Obsidian-Link-Injection-Redirect/releases)
2. Create folder `VaultFolder/.obsidian/plugins/link-injection-redirect/`
3. Copy files into the folder
4. Reload Obsidian and enable the plugin in Settings → Community plugins

---

## Getting Started

### Do You Need Device Profiles?

**If you're NOT syncing plugin settings** across devices (or using a single device), you can skip device profiles entirely. Just use the default/global dictionary settings.

**If you ARE syncing** your vault across multiple devices (laptop, desktop, mobile) and need different values per device (like local file paths), device profiles let you override specific keys per vault path.

For now, let's start with the basics using global settings.

### Setting Up Your First Variable

Let's create a simple variable to see how it works:

1. **Open Plugin Settings**
   - Settings → Link Injection Redirect → "Edit Link Replacement Dictionary"

2. **Add Your First Entry**
   - Key: `GITHUB`
   - Value: `https://github.com/myusername`
   - Leave both toggle buttons enabled (globe + link icons)

3. **Create a Test Link**

   In any note, create an external link:
   ```markdown
   [My Profile](${GITHUB}/myrepo)
   ```

4. **Use the Link**
   - **Right-click** the link
   - You'll see: "Open in webviewer: https://github.com/myusername/myrepo"
   - Click to open!

### Understanding Link Types

The plugin handles two types of links differently:

#### External Links (http://, https://, file://)
```markdown
[Website](https://example.com/${PAGE})
[Local File](file:///${DOCUMENTS}/report.pdf)
```
**How to use:** Right-click → Choose "Open in webviewer" or "Open externally"

#### Internal Links ([[...]])
```markdown
[[Project ${L:project_name}]]
[[Files/${FOLDER}/document]]
```
**How to use:** Cmd/Ctrl+Click (or just click) - Opens directly

---

## Basic Usage

### Dictionary Variables

Dictionary variables are perfect for **values that don't change often** across your vault.

**Common use cases:**
- Server URLs
- File paths
- API endpoints
- Your username/email

**Example: Managing Server Environments**

```markdown
**Settings:**
- DEV: http://localhost:3000
- STAGING: https://staging.myapp.com
- PROD: https://myapp.com

**In your notes:**
[API Docs](${PROD}/docs)
[Admin Panel](${STAGING}/admin)
```

**Syntax:** `${KEY}` (case-insensitive: `${dev}` = `${DEV}` = `${Dev}`)

### Note Properties

Note properties (`${L:property}`) are perfect for **values that change per-note**.

**Common use cases:**
- Task timers with task names
- Project-specific URLs
- Dynamic file organization
- URL scheme automation

**Example: Task Timer Integration**

```yaml
---
task_name: Fix login bug
project: WebApp
---

Start timer: [⏱️](toggl://start?description=${L:task_name}&project=${L:project})
```

When you click the link, it opens Toggl (or your timer app) with:
- Description: "Fix login bug"
- Project: "WebApp"

**Example: Dynamic Documentation**

```yaml
---
library: react
version: 18.2.0
---

- [API Docs](https://${L:library}js.org/docs/${L:version}/)
- [GitHub](https://github.com/facebook/${L:library})
- [NPM](https://npmjs.com/package/${L:library})
```

Change the frontmatter → All links update automatically!

**Syntax:** `${L:property_name}` (accesses frontmatter properties)

**Note:** For internal links, invalid characters (`/`, `\`, `:`) in property values are automatically replaced with spaces (configurable in settings).

### Opening External Links

External links require right-click to see options:

1. **Right-click** the link
2. **Look for menu items** like:
   - "Open in webviewer: [resolved URL]"
   - "Open externally: [resolved URL]"
3. **Click your preferred option**

**Why right-click?** This prevents accidental navigation and lets you choose how to open the link.

**Webviewer Requirements:**
- Desktop only (not available on mobile)
- Settings → Core plugins → Page Preview: Enabled
- "Open external links in" setting: Enabled

If webviewer isn't available, you'll only see the external option.

### Opening Internal Links

Internal links work immediately with Cmd/Ctrl+Click:

```markdown
[[Project Notes/${L:project_name}]]
[[Archive/${L:year}/${L:month}/Report]]
```

Just click → Obsidian navigates to the file (creating it if needed).

---

## Advanced Features

### OR Patterns

OR patterns give you **multiple options for a single link**. Perfect when you have alternatives or fallbacks.

**Syntax:** Separate options with `,,` (double-comma)

#### Basic OR Pattern

```markdown
**Dictionary:**
- RCLONE: file:///Users/name/rclone-mount
- DOWNLOADS: Downloads

**Link:**
[[Files/${RCLONE,,DOWNLOADS}/document.pdf]]
```

**What happens:**
- Click the link → Modal appears with 2 options
- Choose "RCLONE" → Opens from mounted drive
- Choose "DOWNLOADS" → Opens from Downloads folder

#### Real-World Example: Multi-Location Files

```markdown
**Dictionary:**
- LOCAL_DRIVE: file:///Volumes/Projects
- GITHUB_RAW: https://raw.githubusercontent.com/user/repo/main
- WEBDAV: https://webdav.example.com/files

**Link:**
[Source Code](${LOCAL_DRIVE,,GITHUB_RAW,,WEBDAV}/src/main.py)
```

**Use case:** Access the same file from:
- Your local mounted drive (fastest)
- GitHub (when remote)
- WebDAV backup (fallback)

#### Grammar Sugar

Simple variables auto-expand:
```markdown
${one,,two,,three}
```
Is equivalent to:
```markdown
${${one},,${two},,${three}}
```

#### Nested OR Patterns

Mix variables with text:
```markdown
${${RCLONE}/backup,,${CLOUD}/sync,,Downloads}
```

With properties:
```markdown
[[Notes/${${L:Today},,${L:Today}_backup}]]
```

#### Cartesian Product

Multiple OR patterns → All combinations:

```markdown
**Dictionary:**
- SERVER1: https://server1.com
- SERVER2: https://server2.com
- API: /api
- ADMIN: /admin

**Link:**
[Endpoints](${SERVER1,,SERVER2}${API,,ADMIN}/status)
```

**Result:** 4 options (2 × 2):
1. https://server1.com/api/status
2. https://server1.com/admin/status
3. https://server2.com/api/status
4. https://server2.com/admin/status

### Managing Menu Options

By default, each variable shows **two menu items** (webviewer + external). With many variables, your context menu gets crowded.

**Solution:** Disable options you don't need!

#### Setting Per-Key Preferences

1. **Open Settings** → Link Injection Redirect → "Edit Link Replacement Dictionary"
2. **Find your key row**
3. **Toggle the icons:**
   - 🌐 Globe = Webviewer option
   - 🔗 Link = External option

**Example: File paths** → Only external
- Disable webviewer (🌐 off)
- Keep external (🔗 on)
- Result: 1 menu item instead of 2

**Example: Web APIs** → Only webviewer
- Keep webviewer (🌐 on)
- Disable external (🔗 off)
- Result: 1 menu item instead of 2

**Fallback:** If you set webviewer-only but webviewer is disabled, the external option appears automatically.

### Device Profiles

**Skip this section if:**
- You don't sync plugin settings across devices
- All your devices use the same values

**Use device profiles when:**
- Different devices need different paths (laptop vs desktop)
- Some keys don't exist on certain devices (mounted drives on mobile)

#### Creating a Profile

1. **Open Settings** → Link Injection Redirect → "Edit Device Profiles"
2. **Click "Add Device Profile"**
3. **Fill in:**
   - Profile name: `My Laptop`
   - Vault path: `/Users/yourname/Documents/Vault`
4. **Override specific keys:**
   - RCLONE → `file:///Users/yourname/mnt/rclone`
5. **Mark keys as ignored** (optional):
   - RCLONE → Click "Ignored" (for devices without this mount)

#### Example: Desktop + Mobile

**Default Dictionary:**
```
RCLONE: file:///default/path
GITHUB: https://github.com/user/repo
```

**Desktop Profile** (vault path: `/Users/name/vault`):
```
RCLONE: file:///Users/name/mnt/rclone
```

**iPhone Profile** (vault path: `/var/mobile/vault`):
```
RCLONE: @@IGNORE@@ (marked as ignored)
```

**Result:**
- Desktop: Uses custom RCLONE path
- iPhone: RCLONE links don't show (ignored), only other options
- Both: Share same GITHUB value

---

## Real-World Examples

### Example 1: Task Management with URL Schemes

**Problem:** Starting a timer manually every time is tedious.

**Solution:**

```yaml
---
task_name: Implement OAuth
project: Backend
estimate: 2h
---

⏱️ [Start Timer](toggl://start?description=${L:task_name}&project=${L:project})
📝 [Create Ticket](linear://create?title=${L:task_name}&estimate=${L:estimate})
🔗 [Open in IDE](vscode://file/${L:project}/src/${L:task_name}.ts)
```

**One click** → Timer started, ticket created, or IDE opened!

### Example 2: Multi-Device File Access

**Problem:** Want to access files from local drive OR cloud backup.

**Solution:**

```markdown
**Dictionary:**
- DRIVE: file:///Volumes/External
- CLOUD: https://cloud.example.com/files
- DOWNLOADS: Downloads

**Links:**
[[Research Papers/${DRIVE,,CLOUD,,DOWNLOADS}/paper.pdf]]
[Project Files](${DRIVE,,CLOUD}/projects/src/)
```

**At home:** Choose DRIVE (fastest)
**On the go:** Choose CLOUD (accessible anywhere)
**Offline:** Choose DOWNLOADS (local backup)

### Example 3: Development Environment Switching

**Problem:** Constantly switching between dev, staging, and production.

**Solution:**

```markdown
**Dictionary:**
- DEV: http://localhost:3000
- STAGING: https://staging.myapp.com
- PROD: https://myapp.com

**In your notes:**
[API Status](${DEV,,STAGING,,PROD}/api/health)
[Admin Panel](${DEV,,STAGING,,PROD}/admin)
[User Dashboard](${DEV,,STAGING,,PROD}/dashboard?user=test)
```

**Quick testing:** Click → Choose environment → Opens directly

### Example 4: Year-Based Archiving

**Problem:** Organizing files by year, want links to auto-update.

**Solution:**

```yaml
---
year: 2025
quarter: Q1
---

[[Archive/${L:year}/${L:quarter}/Report]]
[[Budget/${L:year}/Expenses]]
```

**Next year:** Just update frontmatter → All links adjust!

### Example 5: Cross-Platform Path Handling

**Problem:** Windows, Mac, and Linux use different path formats.

**Solution with Device Profiles:**

**Default Dictionary:**
```
PROJECTS: /default/path
```

**Windows Profile:**
```
PROJECTS: C:/Users/name/Projects
```

**Mac Profile:**
```
PROJECTS: /Users/name/Projects
```

**Linux Profile:**
```
PROJECTS: /home/name/Projects
```

**Links work everywhere:**
```markdown
[Open Code](file:///${PROJECTS}/myapp/src)
```

---

## Reference

### Pattern Syntax

| Pattern | Description | Example |
|---------|-------------|---------|
| `${KEY}` | Dictionary variable (case-insensitive) | `${HOSTNAME}` |
| `${L:property}` | Note frontmatter property | `${L:task_name}` |
| `${ONE,,TWO}` | OR pattern (choose between options) | `${DEV,,PROD}` |
| `${${KEY},,plain}` | Mixed variable and text | `${${DRIVE}/a,,Downloads}` |

### Key Naming Rules

**Allowed:** Letters, numbers, underscores (`A-Z`, `a-z`, `0-9`, `_`)

**Not allowed:**
- `:` (reserved for `${L:property}`)
- `,` (reserved for OR patterns)

### Case Sensitivity

All dictionary lookups are **case-insensitive**:
- `${hostname}` = `${HOSTNAME}` = `${HostName}`

### Special Features

**dummy:// Prefix:**
Use `dummy://` to help Obsidian recognize links as external:
```markdown
[File](dummy://file:///path/to/file)
```
The plugin automatically strips this prefix when opening.

**Invalid Character Replacement:**
For internal links, property values containing `/`, `\`, or `:` are automatically replaced with spaces (configurable in settings).

### Webviewer Detection

The plugin checks three conditions:
1. Plugin exists (desktop only)
2. Plugin is loaded
3. "Open external links in" setting is enabled

If any condition fails, only the external option is shown.

### Mobile Support

- Device profiles: ✅ Work on mobile
- Webviewer: ❌ Not available (only external opening)
- All other features: ✅ Work identically

---

## Troubleshooting

### Variables Not Replaced

**Check:**
- ✅ Spelling matches dictionary key (case doesn't matter)
- ✅ Key exists in dictionary or frontmatter
- ✅ For `${L:property}`, property exists in current note's frontmatter

### Context Menu Not Showing

**Requirements:**
- ✅ Must be an external URL (http://, https://, file://)
- ✅ Must contain a variable pattern
- ✅ Right-click on the link itself, not just the text

### Nested OR Patterns Not Working

**Check:**
- ✅ Using `,,` (double-comma), not `,` (single comma)
- ✅ Braces are balanced (each `${` has a matching `}`)
- ✅ Reload Obsidian completely (Ctrl/Cmd+R) after plugin updates

### Webviewer Option Missing

**Check Settings → Core plugins → Page Preview:**
- ✅ Plugin enabled
- ✅ "Open external links in" setting toggled on
- ❌ Not available on mobile (by design)

### Links Open in Wrong Application

**Check:**
- ✅ Per-key preferences in plugin settings
- ✅ Webviewer-only keys fall back to external when webviewer is disabled
- ✅ Right-click to see available options

### Device Profile Not Working

**Check:**
- ✅ Vault path matches **exactly** (copy from Obsidian settings)
- ✅ Key override exists in profile
- ✅ Not using ignored key (`@@IGNORE@@`)

---

## Support

- **Issues**: [GitHub Issues](https://github.com/ctrl-alt-delete-8/Obsidian-Link-Injection-Redirect/issues)
- **Discord**: [Join our Discord](https://discord.com/invite/bXMpCTBMcg)
- **Donate**: [Buy me a coffee](https://www.buymeacoffee.com/tinkerer.ctrl.alt.del)

## Credits

Created by [@tinkerer-ctrl-alt-del](https://github.com/ctrl-alt-delete-8)
