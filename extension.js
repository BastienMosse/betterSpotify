/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// File layout:
//   extension.js     — entry point + top bar menu (this file)
//   player.js        — MPRIS / D-Bus communication with Spotify
//   emitter.js       — lightweight signal system (connect / disconnect / emit)
//   panelPosition.js — indicator placement in the top bar
//   prefs.js         — preferences window

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {SpotifyPlayer} from './player.js';
import {addToPanel} from './panelPosition.js';

const SPOTIFY_DESKTOP_IDS = ['com.spotify.Client.desktop', 'spotify.desktop', 'spotify_spotify.desktop'];
const TICK_MS = 250;                 // progress bar refresh interval
const RESYNC_EVERY = 12;             // ticks between real position reads (~3 s)
const VOLUME_STEP = 0.05;

/** 83000 -> "1:23" */
function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function spotifyApp() {
    const appSystem = Shell.AppSystem.get_default();
    for (const id of SPOTIFY_DESKTOP_IDS) {
        const app = appSystem.lookup_app(id);
        if (app)
            return app;
    }
    return null;
}

/** Small round button with an icon. */
function controlButton(iconName, callback, {big = false} = {}) {
    const button = new St.Button({
        style_class: big ? 'better-spotify-control big' : 'better-spotify-control',
        child: new St.Icon({icon_name: iconName, icon_size: big ? 20 : 16}),
        can_focus: true,
    });
    button.connect('clicked', callback);
    return button;
}

/** Non-clickable menu item (used as a container for custom widgets). */
function containerItem(styleClass) {
    return new PopupMenu.PopupBaseMenuItem({
        activate: false,
        hover: false,
        can_focus: false,
        style_class: styleClass,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Top bar indicator
// ═══════════════════════════════════════════════════════════════════════════

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Better Spotify');

        this._ext = extension;
        this._player = extension.player;
        this._settings = extension.settings;

        // Top bar: icon + "Artist — Title"
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelLabel = new St.Label({
            style_class: 'better-spotify-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._panelIcon);
        box.add_child(this._panelLabel);
        this.add_child(box);

        // Scroll on the icon = volume
        this.connect('scroll-event', (_actor, event) => this._onScroll(event));

        this._buildMenu();

        this._playerIds = [
            this._player.connect('changed', () => this.sync()),
        ];
        this._settingsIds = [
            this._settings.connect('changed::panel-show-icon', () => this.sync()),
            this._settings.connect('changed::panel-show-title', () => this.sync()),
            this._settings.connect('changed::panel-show-artist', () => this.sync()),
        ];
        this.connect('destroy', () => {
            this._playerIds.forEach(id => this._player.disconnect(id));
            this._settingsIds.forEach(id => this._settings.disconnect(id));
        });

        this.sync();
    }

    // ── Menu construction ──────────────────────────────────────────────────

    _buildMenu() {
        this.menu.box.add_style_class_name('better-spotify-menu');

        // Album art + track info (click = open Spotify)
        this._trackItem = new PopupMenu.PopupBaseMenuItem({style_class: 'better-spotify-track'});
        this._cover = new St.Icon({style_class: 'better-spotify-cover', icon_size: 72});
        const info = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._titleLabel = new St.Label({style_class: 'better-spotify-title'});
        this._artistLabel = new St.Label({style_class: 'better-spotify-artist'});
        this._albumLabel = new St.Label({style_class: 'better-spotify-album'});
        for (const label of [this._titleLabel, this._artistLabel, this._albumLabel]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            info.add_child(label);
        }
        this._trackItem.add_child(this._cover);
        this._trackItem.add_child(info);
        this._trackItem.connect('activate', () => spotifyApp()?.activate());
        this.menu.addMenuItem(this._trackItem);

        // Progress bar
        const progressItem = containerItem('better-spotify-progress');
        const progressBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._progress = new Slider(0);
        this._progress.accessible_name = 'Playback position';
        this._progressDragging = false;
        this._progressUpdating = false;
        this._progress.connect('drag-begin', () => (this._progressDragging = true));
        this._progress.connect('drag-end', () => {
            this._progressDragging = false;
            this._seekFromSlider();
        });
        this._progress.connect('notify::value', () => {
            if (this._progressUpdating)
                return;                       // internal update — ignore
            if (this._progressDragging)
                this._elapsedLabel.text = formatTime(this._progress.value * this._player.lengthMs);
            else
                this._seekFromSlider();       // scroll wheel / keyboard
        });
        const times = new St.BoxLayout({x_expand: true});
        this._elapsedLabel = new St.Label({style_class: 'better-spotify-time', x_expand: true});
        this._durationLabel = new St.Label({style_class: 'better-spotify-time'});
        times.add_child(this._elapsedLabel);
        times.add_child(this._durationLabel);
        progressBox.add_child(this._progress);
        progressBox.add_child(times);
        progressItem.add_child(progressBox);
        this.menu.addMenuItem(progressItem);

        // Playback controls
        const controlsItem = containerItem('better-spotify-controls');
        const controls = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._shuffleButton = controlButton('media-playlist-shuffle-symbolic',
            () => this._player.setShuffle(!this._player.shuffle));
        this._playButton = controlButton('media-playback-start-symbolic',
            () => this._player.playPause(), {big: true});
        this._repeatButton = controlButton('media-playlist-repeat-symbolic',
            () => this._cycleRepeat());
        controls.add_child(this._shuffleButton);
        controls.add_child(controlButton('media-skip-backward-symbolic', () => this._player.previous()));
        controls.add_child(this._playButton);
        controls.add_child(controlButton('media-skip-forward-symbolic', () => this._player.next()));
        controls.add_child(this._repeatButton);
        controlsItem.add_child(controls);
        this.menu.addMenuItem(controlsItem);

        // Volume
        const volumeItem = containerItem('better-spotify-volume');
        this._volumeIcon = new St.Icon({icon_name: 'audio-volume-high-symbolic', icon_size: 16});
        this._volume = new Slider(1);
        this._volume.x_expand = true;
        this._volume.accessible_name = 'Spotify volume';
        this._volumeUpdating = false;
        this._volumeDragging = false;
        this._volume.connect('drag-begin', () => (this._volumeDragging = true));
        this._volume.connect('drag-end', () => (this._volumeDragging = false));
        this._volume.connect('notify::value', () => {
            if (!this._volumeUpdating)
                this._player.setVolume(this._volume.value);
            this._syncVolumeLabel(this._volume.value);
        });
        this._volumeLabel = new St.Label({style_class: 'better-spotify-time', y_align: Clutter.ActorAlign.CENTER});
        volumeItem.add_child(this._volumeIcon);
        volumeItem.add_child(this._volume);
        volumeItem.add_child(this._volumeLabel);
        this.menu.addMenuItem(volumeItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._openItem = this.menu.addAction('Open Spotify', () => spotifyApp()?.activate());
        this.menu.addAction('Extension settings', () => this._ext.openPreferences());

        // Player sections are hidden when Spotify is not running
        this._playerItems = [this._trackItem, progressItem, controlsItem, volumeItem];

        // When Spotify is not running and "launch on click" is enabled,
        // clicking the indicator launches Spotify instead of opening the menu.
        const toggleMenu = this.menu.toggle.bind(this.menu);
        this.menu.toggle = () => {
            const app = spotifyApp();
            if (!this._player.available && app && this._settings.get_boolean('launch-on-click'))
                app.activate();
            else
                toggleMenu();
        };

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._player.syncPosition();
                this.sync();
            }
        });
    }

    // ── Display update ─────────────────────────────────────────────────────

    /** Refresh the entire menu from the player state. */
    sync() {
        const p = this._player;
        const available = p.available;

        this._playerItems.forEach(item => (item.visible = available));
        this._openItem.label.text = available ? 'Open Spotify' : 'Launch Spotify';
        this._panelIcon.opacity = available ? 255 : 128;

        // Top bar: icon / artist / title based on settings
        const artist = p.artists.join(', ');
        const parts = [];
        if (available && this._settings.get_boolean('panel-show-artist') && artist)
            parts.push(artist);
        if (available && this._settings.get_boolean('panel-show-title') && p.title)
            parts.push(p.title);
        const panelText = parts.join(' — ');
        this._panelLabel.visible = !!panelText;
        this._panelLabel.text = panelText;
        // The icon is always visible when there's no text (no track playing
        // or all labels disabled), so the button doesn't become invisible.
        this._panelIcon.visible = !panelText || this._settings.get_boolean('panel-show-icon');

        if (!available)
            return;

        // Track info
        this._titleLabel.text = p.title || 'No track';
        this._artistLabel.text = artist;
        this._albumLabel.text = p.album;
        if (p.artUrl !== this._coverUrl) {
            this._coverUrl = p.artUrl;
            this._cover.gicon = p.artUrl
                ? new Gio.FileIcon({file: Gio.File.new_for_uri(p.artUrl)})
                : new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        }

        // Buttons
        this._playButton.child.icon_name = p.playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._setChecked(this._shuffleButton, p.shuffle);
        this._repeatButton.child.icon_name = p.loopStatus === 'Track'
            ? 'media-playlist-repeat-song-symbolic'
            : 'media-playlist-repeat-symbolic';
        this._setChecked(this._repeatButton, p.loopStatus !== 'None');

        // Volume (skip if the user is dragging the slider)
        if (!this._volumeDragging) {
            this._volumeUpdating = true;
            this._volume.value = p.volume;
            this._volumeUpdating = false;
        }

        this.updatePosition();
    }

    /** Called on each tick: progress bar + elapsed time. */
    updatePosition() {
        if (!this.menu.isOpen || this._progressDragging || !this._player.available)
            return;
        const pos = this._player.positionMs;
        const length = this._player.lengthMs;
        this._progressUpdating = true;
        this._progress.value = length > 0 ? pos / length : 0;
        this._progressUpdating = false;
        this._elapsedLabel.text = formatTime(pos);
        this._durationLabel.text = formatTime(length);
    }

    _syncVolumeLabel(value) {
        this._volumeLabel.text = `${Math.round(value * 100)} %`;
        this._volumeIcon.icon_name = value === 0 ? 'audio-volume-muted-symbolic'
            : value < 0.33 ? 'audio-volume-low-symbolic'
                : value < 0.66 ? 'audio-volume-medium-symbolic'
                    : 'audio-volume-high-symbolic';
    }

    _setChecked(button, checked) {
        if (checked)
            button.add_style_pseudo_class('checked');
        else
            button.remove_style_pseudo_class('checked');
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    _seekFromSlider() {
        this._player.seekTo(this._progress.value * this._player.lengthMs);
    }

    _cycleRepeat() {
        // Off -> playlist -> track -> off
        const next = {None: 'Playlist', Playlist: 'Track', Track: 'None'};
        this._player.setLoopStatus(next[this._player.loopStatus] ?? 'None');
    }

    _onScroll(event) {
        if (!this._player.available)
            return Clutter.EVENT_PROPAGATE;

        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = VOLUME_STEP;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = -VOLUME_STEP;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            delta = -dy * VOLUME_STEP;
            break;
        }
        }
        if (delta === 0)
            return Clutter.EVENT_PROPAGATE;

        const volume = Math.clamp(this._player.volume + delta, 0, 1);
        this._player.setVolume(volume);
        Main.osdWindowManager.showAll(Gio.ThemedIcon.new('audio-x-generic-symbolic'),
            'Spotify', volume, 1);
        return Clutter.EVENT_STOP;
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default class BetterSpotifyExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.player = new SpotifyPlayer();
        this._tickCount = 0;

        this._indicator = new Indicator(this);
        // Place the indicator in the panel according to settings (and moves it on change)
        this._stopPanelTracking = addToPanel(this.uuid, this._indicator, this.settings);

        this._playerIds = [
            this.player.connect('changed', () => this._syncTimer()),
            this.player.connect('seeked', () => this._tick(false)),
        ];
        this._syncTimer();
    }

    disable() {
        // Everything created in enable() must be destroyed here.
        this._stopTimer();

        this._playerIds.forEach(id => this.player.disconnect(id));

        this._stopPanelTracking();
        this._indicator.destroy();
        this._indicator = null;

        this.player.destroy();
        this.player = null;
        this.settings = null;
    }

    // ── Timer: runs only during playback ───────────────────────────────────

    _syncTimer() {
        if (this.player.playing)
            this._startTimer();
        else
            this._stopTimer();
        this._tick(false);
    }

    _startTimer() {
        if (this._timerId)
            return;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            this._tick(true);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _tick(fromTimer) {
        if (fromTimer && ++this._tickCount % RESYNC_EVERY === 0)
            this.player.syncPosition();

        this._indicator.updatePosition();
    }
}
