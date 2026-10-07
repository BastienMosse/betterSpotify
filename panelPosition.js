// panelPosition.js — Places the extension indicator in the top bar at the
// position chosen in settings (panel-position and panel-index keys).
//
// The top bar has three sections: Main.panel._leftBox, _centerBox and
// _rightBox. addToStatusArea() handles initial placement; to move the
// indicator later, we remove it from its current section and reinsert it.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BOXES = {
    left: () => Main.panel._leftBox,
    center: () => Main.panel._centerBox,
    right: () => Main.panel._rightBox,
};

/**
 * Adds the indicator to the panel and keeps it in sync with settings.
 * Returns a function to call in disable() to stop tracking.
 */
export function addToPanel(uuid, indicator, settings) {
    Main.panel.addToStatusArea(uuid, indicator,
        settings.get_int('panel-index'),
        settings.get_string('panel-position'));

    const move = () => {
        const box = (BOXES[settings.get_string('panel-position')] ?? BOXES.right)();
        const container = indicator.container;     // the actor actually placed in the section
        container.get_parent()?.remove_child(container);
        // An index that's too large simply places the icon at the end
        box.insert_child_at_index(container, settings.get_int('panel-index'));
    };

    const ids = [
        settings.connect('changed::panel-position', move),
        settings.connect('changed::panel-index', move),
    ];
    return () => ids.forEach(id => settings.disconnect(id));
}
