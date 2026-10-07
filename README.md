# Better Spotify

A GNOME Shell extension that integrates Spotify controls into the top bar.

## Features

- **Panel indicator** — shows the current track title and artist in the top bar
- **Playback controls** — play, pause, previous, next
- **Shuffle and repeat** — toggle from the dropdown menu
- **Volume slider** — adjust Spotify volume independently from system volume
- **Progress bar** — track position with real-time interpolation
- **Album art** — displays cover art in the dropdown menu
- **Launch on click** — opens Spotify when clicking the indicator if it's not running
- **Configurable position** — place the indicator in the left, center, or right section of the top bar

## Requirements

- GNOME Shell 50+
- Spotify (desktop client)
- D-Bus (MPRIS interface)

## Installation

### From source

```bash
git clone https://github.com/BastienMOSSE/BetterSpotify.git
cd BetterSpotify
cp -r . ~/.local/share/gnome-shell/extensions/betterSpotify@lucipher-lab.fr
```

Then restart GNOME Shell (`Alt+F2`, type `r`, press Enter on X11 — or log out and back in on Wayland) and enable the extension:

```bash
gnome-extensions enable betterSpotify@lucipher-lab.fr
```

### From the Extensions app

Search for "Better Spotify" in the GNOME Extensions app, or install from [extensions.gnome.org](https://extensions.gnome.org).

## Configuration

Open the extension preferences from the Extensions app or run:

```bash
gnome-extensions prefs betterSpotify@lucipher-lab.fr
```

| Setting | Default | Description |
|---------|---------|-------------|
| Zone | Right | Top bar section (left, center, right) |
| Position in zone | 0 | Index within the chosen section |
| Show icon | On | Display the Spotify logo in the panel |
| Show title | On | Display the track title in the panel |
| Show artist | On | Display the artist name in the panel |
| Launch on click | On | Open Spotify when clicking the indicator if it's not running |

## How it works

The extension communicates with Spotify through the [MPRIS D-Bus interface](https://specifications.freedesktop.org/mpris-spec/latest/), which is the standard protocol for media player control on Linux. Track position is read periodically and interpolated between reads for a smooth progress bar.

## Project structure

```
BetterSpotify/
├── extension.js       # Entry point, panel indicator and dropdown menu
├── player.js          # MPRIS/D-Bus communication with Spotify
├── emitter.js         # Lightweight event emitter
├── panelPosition.js   # Panel placement logic
├── prefs.js           # Preferences window (GTK4/Adw)
├── stylesheet.css     # St CSS styles
├── metadata.json      # Extension metadata
└── schemas/
    └── org.gnome.shell.extensions.better-spotify.gschema.xml
```

## License

GPL-2.0-or-later
