// player.js — Communicates with Spotify via MPRIS (D-Bus).
//
// MPRIS is the standard interface that media players expose on the session
// D-Bus. You can explore it manually with:
//   busctl --user introspect org.mpris.MediaPlayer2.spotify /org/mpris/MediaPlayer2
//
// Spotify does not stream the playback position continuously: we read it
// periodically (resync) and extrapolate between reads using the clock.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from './emitter.js';

// Allows writing `await xxx_async(...)` instead of passing a callback.
Gio._promisify(Gio.DBusProxy, 'new_for_bus');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

const BUS_NAME = 'org.mpris.MediaPlayer2.spotify';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

// All positions/durations are in milliseconds on the extension side
// (MPRIS uses microseconds).
const US_PER_MS = 1000;

/**
 * Emits the following signals:
 *  - 'availability-changed' : Spotify just appeared / disappeared
 *  - 'changed'              : status, volume, repeat, shuffle… changed
 *  - 'track-changed'        : new track started
 *  - 'seeked'               : playback position jumped (seek from menu)
 */
export class SpotifyPlayer extends EventEmitter {
    constructor() {
        super();

        this._proxy = null;
        this._cancellable = new Gio.Cancellable();
        this._metadata = {};
        this._trackId = null;

        // Last known position from Spotify and the monotonic clock
        // timestamp (in µs) when it was received.
        this._positionMs = 0;
        this._positionStamp = GLib.get_monotonic_time();

        // Watch for Spotify appearing or disappearing on the bus.
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._onAppeared(),
            () => this._onVanished());
    }

    // ── State ──────────────────────────────────────────────────────────────

    get available() {
        return this._proxy !== null;
    }

    get status() {
        return this._get('PlaybackStatus') ?? 'Stopped';
    }

    get playing() {
        return this.status === 'Playing';
    }

    get trackId() {
        return this._trackId;
    }

    get title() {
        return this._metadata['xesam:title'] ?? '';
    }

    get artists() {
        return this._metadata['xesam:artist'] ?? [];
    }

    get album() {
        return this._metadata['xesam:album'] ?? '';
    }

    get artUrl() {
        return this._metadata['mpris:artUrl'] ?? '';
    }

    get lengthMs() {
        return Number(this._metadata['mpris:length'] ?? 0) / US_PER_MS;
    }

    /** Spotify ads (trackid /com/spotify/ad/…). */
    get isAd() {
        return this._trackId?.startsWith('/com/spotify/ad/') ?? false;
    }

    get volume() {
        return this._get('Volume') ?? 1;
    }

    get shuffle() {
        return this._get('Shuffle') ?? false;
    }

    /** 'None' | 'Track' | 'Playlist' */
    get loopStatus() {
        return this._get('LoopStatus') ?? 'None';
    }

    /** Current extrapolated position (ms). */
    get positionMs() {
        let pos = this._positionMs;
        if (this.playing)
            pos += (GLib.get_monotonic_time() - this._positionStamp) / US_PER_MS;
        const length = this.lengthMs;
        return length > 0 ? Math.min(pos, length) : pos;
    }

    // ── Commands ────────────────────────────────────────────────────────────

    playPause() {
        this._callPlayer('PlayPause');
    }

    next() {
        this._callPlayer('Next');
    }

    previous() {
        this._callPlayer('Previous');
    }

    seekTo(ms) {
        if (!this._trackId)
            return;
        ms = Math.max(0, Math.round(ms));
        this._callPlayer('SetPosition',
            new GLib.Variant('(ox)', [this._trackId, ms * US_PER_MS]));
        // Update immediately so the UI responds without waiting.
        this._setPosition(ms);
        this.emit('seeked');
    }

    setVolume(value) {
        this._setProp('Volume', new GLib.Variant('d', Math.min(Math.max(value, 0), 1)));
    }

    setShuffle(value) {
        this._setProp('Shuffle', new GLib.Variant('b', value));
    }

    setLoopStatus(value) {
        this._setProp('LoopStatus', new GLib.Variant('s', value));
    }

    /** Fetch the real position from Spotify (corrects extrapolation drift). */
    async syncPosition() {
        if (!this._proxy)
            return;
        try {
            const reply = await Gio.DBus.session.call(
                BUS_NAME, OBJECT_PATH, PROPS_IFACE, 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                null, Gio.DBusCallFlags.NONE, 1000, this._cancellable);
            const [variant] = reply.deepUnpack();
            this._setPosition(Number(variant.unpack()) / US_PER_MS);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`[better-spotify] syncPosition: ${e.message}`);
        }
    }

    destroy() {
        this._cancellable.cancel();
        Gio.bus_unwatch_name(this._watchId);
        this._dropProxy();
    }

    // ── Internal ────────────────────────────────────────────────────────────

    async _onAppeared() {
        try {
            const proxy = await Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                BUS_NAME, OBJECT_PATH, PLAYER_IFACE, this._cancellable);

            this._dropProxy();
            this._proxy = proxy;
            this._propsId = proxy.connect('g-properties-changed',
                (_p, changed) => this._onPropertiesChanged(changed.deepUnpack()));
            this._signalId = proxy.connect('g-signal', (_p, _sender, name, params) => {
                if (name === 'Seeked') {
                    const [posUs] = params.deepUnpack();
                    this._setPosition(Number(posUs) / US_PER_MS);
                    this.emit('seeked');
                }
            });

            this._readMetadata();
            await this.syncPosition();
            this.emit('availability-changed');
            this.emit('track-changed');
            this.emit('changed');
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`[better-spotify] MPRIS proxy: ${e.message}`);
        }
    }

    _onVanished() {
        if (!this._proxy)
            return;
        this._dropProxy();
        this._metadata = {};
        this._trackId = null;
        this.emit('availability-changed');
        this.emit('track-changed');
        this.emit('changed');
    }

    _dropProxy() {
        if (!this._proxy)
            return;
        this._proxy.disconnect(this._propsId);
        this._proxy.disconnect(this._signalId);
        this._proxy = null;
    }

    _onPropertiesChanged(changed) {
        let trackChanged = false;

        if ('Metadata' in changed)
            trackChanged = this._readMetadata();

        if ('PlaybackStatus' in changed || trackChanged) {
            // On pause/play, freeze the extrapolated position then resync.
            this._setPosition(trackChanged ? 0 : this.positionMs);
            this.syncPosition();
        }

        if (trackChanged)
            this.emit('track-changed');
        this.emit('changed');
    }

    /** @returns {boolean} true if the track changed */
    _readMetadata() {
        const variant = this._proxy?.get_cached_property('Metadata');
        this._metadata = variant ? variant.recursiveUnpack() : {};
        const id = this._metadata['mpris:trackid'] ?? null;
        const changed = id !== this._trackId;
        this._trackId = id;
        return changed;
    }

    _get(name) {
        return this._proxy?.get_cached_property(name)?.unpack() ?? null;
    }

    _setPosition(ms) {
        this._positionMs = ms;
        this._positionStamp = GLib.get_monotonic_time();
    }

    _callPlayer(method, params = null) {
        this._proxy?.call(method, params, Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (proxy, res) => {
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[better-spotify] ${method}: ${e.message}`);
                }
            });
    }

    _setProp(name, variant) {
        if (!this._proxy)
            return;
        Gio.DBus.session.call(
            BUS_NAME, OBJECT_PATH, PROPS_IFACE, 'Set',
            new GLib.Variant('(ssv)', [PLAYER_IFACE, name, variant]),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[better-spotify] Set ${name}: ${e.message}`);
                }
            });
    }
}
