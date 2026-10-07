import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function panelGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Top Bar',
        description: 'Changes apply immediately.',
    });

    const zones = ['left', 'center', 'right'];
    const zoneRow = new Adw.ComboRow({
        title: 'Zone',
        model: Gtk.StringList.new(['Left', 'Center', 'Right']),
        selected: Math.max(0, zones.indexOf(settings.get_string('panel-position'))),
    });
    zoneRow.connect('notify::selected',
        () => settings.set_string('panel-position', zones[zoneRow.selected]));
    group.add(zoneRow);

    const indexRow = Adw.SpinRow.new_with_range(0, 30, 1);
    indexRow.title = 'Position in zone';
    indexRow.subtitle = '0 = leftmost in the zone';
    settings.bind('panel-index', indexRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(indexRow);

    return group;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class BetterSpotifyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const panel = panelGroup(settings);
        panel.add(switchRow(settings, 'panel-show-icon', 'Show icon',
            'Always shown when no track is playing'));
        panel.add(switchRow(settings, 'panel-show-title', 'Show track title'));
        panel.add(switchRow(settings, 'panel-show-artist', 'Show artist'));
        panel.add(switchRow(settings, 'launch-on-click', 'Launch Spotify on click',
            'If Spotify is not running, clicking the icon launches it instead of opening the menu'));
        page.add(panel);

        window.add(page);
    }
}
