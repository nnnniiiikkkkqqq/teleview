# Teleview

Teleview is a private, local-first reader for Telegram Desktop exports. It recreates the comfortable parts of the Telegram client for an archive: chat browsing, message bubbles, search, reply navigation, media previews, shared files, themes, and responsive mobile/desktop layouts.

Your export is opened directly by the browser. Teleview does not upload it, contact Telegram, fetch remote previews, or change files in the selected folder.

## Start the app

On macOS, double-click **Open Teleview.command**.

Or start it from a terminal:

```sh
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). No package installation is required; the app has no third-party runtime dependencies.

## Open a Telegram export

1. In Telegram Desktop, open **Settings → Advanced → Export Telegram data**.
2. Choose **Machine-readable JSON** for the richest, most reliable result. HTML exports are also supported.
3. Include the media types you want to preview, then let Telegram finish the export.
4. In Teleview, choose the export folder itself—the folder containing `result.json` or `messages.html`.

You can also drag the whole export folder onto the welcome screen. If the browser cannot keep folder permission, Teleview falls back to the standard folder chooser.

## Included features

- Full-account and single-chat JSON exports
- Single and paginated HTML exports, including multi-chat account folders
- Private chats, groups, channels, bots, and Saved Messages
- Persistent sender names, avatars, and colors, including exports where the owner cannot be identified
- Rich text, links, replies, forwards, service events, edits, views, and reactions
- Photos, videos, GIFs, files, music, voice messages, stickers in chat, polls, contacts, and locations
- Lazy local media loading, missing-media placeholders, downloads, and a media lightbox
- Global and current-chat search with exact phrases and filters
- Chat type filters, date jumping, and a deep-scrolling shared-content drawer with separate photo, video, file, music, link, voice-message, and GIF categories (stickers stay out of shared media)
- Desktop, tablet, and one-pane mobile layouts
- System/light/dark themes and three text sizes
- Keyboard shortcuts and reduced-motion support

### Search examples

```text
launch plan
"exact phrase"
from:"Alex Morgan"
in:"Family"
has:photo
has:file after:2024-01-01
before:2023-12-31 weekend
```

Search is case- and accent-insensitive. Filters can be combined with ordinary words or quoted phrases.

## Privacy and browser support

- Archive data and media stay in memory in the current browser session.
- A folder handle is stored only if **Remember this folder** is selected.
- **Forget remembered folder** removes that permission reference; it never touches the export.
- A restrictive content policy prevents background network connections. External message links or map coordinates open only after you click them.
- Chrome, Edge, or another Chromium browser provides the smoothest folder-permission experience. Safari and Firefox can use the folder-upload fallback.

## Development and verification

```sh
npm test
npm run check
```

The test suite covers JSON and HTML import variants, export edge cases, search parsing, ranking, filtering, highlighting, and index updates.

## Limits of exported history

Teleview can only display what Telegram Desktop included. Missing media, replies to messages outside the export, and unsupported browser codecs are shown safely instead of breaking a chat. Secret chats are generally not included by Telegram Desktop's exporter.
