// emitter.js — Lightweight signal system (connect / disconnect / emit).
//
// Minimal equivalent of GNOME Shell's Signals.EventEmitter.

export class EventEmitter {
    constructor() {
        this._handlers = new Map();
        this._nextId = 1;
    }

    connect(name, callback) {
        const id = this._nextId++;
        this._handlers.set(id, {name, callback});
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    emit(name, ...args) {
        for (const {name: n, callback} of [...this._handlers.values()]) {
            if (n === name)
                callback(this, ...args);
        }
    }
}
