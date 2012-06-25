const Lang = imports.lang;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const Util = imports.misc.util;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;
const PanelMenu = imports.ui.panelMenu;
const ModalDialog = imports.ui.modalDialog;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

const DIALOG_GROW_TIME = 0.1;

const SETTINGS_CUSTOM_SOCKET_DIR_ENABLED_KEY = 'custom-socket-dir-enabled';
const SETTINGS_CUSTOM_SOCKET_DIR_KEY = 'custom-socket-dir';
const SETTINGS_VIRTUAL_ENVIRONMENT_DIR_KEY = 'virtual-environment-dir';
const SETTINGS_DESKTOP_DIR_KEY = 'desktop-dir';

let settings;
let emStatusButton;
let emRunDialog;
let defaultSocketDir;

function _expandPath(path) {
    return path.replace(new RegExp('^~'), GLib.get_home_dir());
}

const EmacsMenuItem = new Lang.Class({
    Name: 'EmacsManager.EmacsMenuItem',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function(name) {
        this.parent({
            reactive: false
        });

        this.name = name;

        let a = new PopupMenu.PopupMenuItem(name);
        this.addActor(a.actor, {expand: true});

        let b = new St.Button({
            child: new St.Icon({
                icon_name: 'edit-delete',
                icon_type: St.IconType.SYMBOLIC,
                icon_size: 22
            })
        });
        this.addActor(b);

        a.connect('activate', Lang.bind(this, this._onStartClient));
        b.connect('clicked', Lang.bind(this, this._onKillServer));
    },

    _onStartClient: function(e) {
        this.emit('start-client', { name: this.name });
    },

    _onKillServer: function(e) {
        this.emit('kill-server', { name: this.name });
    }
});


const EmacsStatusButton = new Lang.Class({
    Name: 'EmacsManager.EmacsStatusButton',
    Extends: PanelMenu.SystemStatusButton,

    _init: function() {
        this.parent('accessories-text-editor');

        this._contentSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._contentSection);

        this.menu.addAction(_("Start emacs server"),
                            Lang.bind(this, this._onStartServer));

        this.menu.connect('open-state-changed', Lang.bind(this, this._update));

        this._update();
    },

    _onStartServer: function() {
        emRunDialog.open();
    },

    _onStartClient: function(e) {
        this.menu.close();
        Util.spawn(['emacsclient',
                    '-c',
                    '-n',
                    '-s', e.name])
    },

    _onKillServer: function(e) {
        this.menu.close();
        Util.spawn(['emacsclient',
                    '-s', e.name,
                    '-e', '(kill-emacs)'])
    },

    _update: function(e) {
        if (e) {
            this._contentSection.removeAll();
            let file,
                info,
                fileEnum,
                socketDir,
                count = 0;

            if (settings.get_boolean(SETTINGS_CUSTOM_SOCKET_DIR_ENABLED_KEY)) {
                socketDir = settings.get_string(SETTINGS_CUSTOM_SOCKET_DIR_KEY);
            } else {
                socketDir = defaultSocketDir;
            }
            socketDir = Gio.file_new_for_path(socketDir);

            try {
                fileEnum = socketDir.enumerate_children('standard::*',
                                                        Gio.FileQueryInfoFlags.NONE,
                                                        null);
            } catch (e) {
                this._removeSeparator();
                return;
            }

            while ((info = fileEnum.next_file(null)) != null) {
                let name = info.get_name();
                let item = new EmacsMenuItem(name, this);
                item.connect('start-client', Lang.bind(this, this._onStartClient));
                item.connect('kill-server', Lang.bind(this, this._onKillServer));
                this._contentSection.addMenuItem(item);
                count += 1;
            }
            fileEnum.close(null);

            if (count > 0) {
                this._addSeparator();
            } else {
                this._removeSeparator();
            }
        }
    },

    _addSeparator: function() {
        if (!this._separator) {
            this._separator = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._separator, 1);
        }
    },
    _removeSeparator: function() {
        if (this._separator) {
            this._separator.destroy();
            this._separator = undefined;
        }
    }
});


const EmacsRunCompleter = new Lang.Class({
    Name: 'EmacsManager.EmacsRunCompleter',

    _init: function() {
        this._re = new RegExp('([^\\.]+)\\.desktop');
    },

    getCompletion: function(text) {
        let common = '',
            notInit = true,
            items = this._items,
            itemsLen = items.length;

        for (let i = 0; i < itemsLen; i++) {
            if (items[i].indexOf(text) != 0) {
                continue;
            }
            if (notInit) {
                common = items[i];
                notInit = false;
            }
            common = this._getCommon(common, items[i]);
        }
        if (common.length)
            return common.substr(text.length);
        return common;
    },

    update: function() {
        let fileEnum,
            path = _expandPath(settings.get_string(SETTINGS_DESKTOP_DIR_KEY)),
            dir = Gio.file_new_for_path(path);

        this._items = [];

        if (dir.query_exists(null)) {
            fileEnum = dir.enumerate_children('standard::*',
                                              Gio.FileQueryInfoFlags.NONE,
                                              null);
            while ((info = fileEnum.next_file(null)) != null) {
                let name = info.get_name();
                let match = this._re.exec(name);
                if (match) {
                    this._items.push(match[1]);
                }
            }
        }
    },

    _getCommon: function(s1, s2) {
        let k = 0,
            s1Len = s1.length,
            s2Len = s2.length;
        for (; k < s1Len && k < s2Len; k++) {
            if (s1[k] != s2[k])
                break;
        }
        if (k == 0)
            return '';
        return s1.substr(0, k);
    }
});


const EmacsRunDialog = new Lang.Class({
    Name: 'EmacsManager.EmacsRunDialog',
    Extends: ModalDialog.ModalDialog,

    _init: function() {
        let label,
            entry,
            errorIcon;

        this.parent({ styleClass: 'run-dialog' });

        this._completer = new EmacsRunCompleter();

        label = new St.Label({
            style_class: 'run-dialog-label',
            text: _("Please enter emacs server name:")
        });
        this.contentLayout.add(label, { y_align: St.Align.START });

        entry = new St.Entry({ style_class: 'run-dialog-entry' });
        entry.label_actor = label;
        this._entryText = entry.clutter_text;
        this.contentLayout.add(entry, { y_align: St.Align.START });
        this.setInitialKeyFocus(this._entryText);

        this._errorBox = new St.BoxLayout({
            style_class: 'run-dialog-error-box'
        });

        this.contentLayout.add(this._errorBox, { expand: true });

        errorIcon = new St.Icon({
            icon_name: 'dialog-error',
            icon_size: 24,
            style_class: 'run-dialog-error-icon'
        });

        this._errorBox.add(errorIcon, { y_align: St.Align.MIDDLE });

        this._commandError = false;

        this._errorMessage = new St.Label({
            style_class: 'run-dialog-error-label'
        });
        this._errorMessage.clutter_text.line_wrap = true;

        this._errorBox.add(this._errorMessage, {
            expand: true,
            y_align: St.Align.MIDDLE,
            y_fill: false
        });

        this._errorBox.hide();

        this._entryText.connect('key-press-event',
                                Lang.bind(this, this._onKeyPress));
    },

    pushModal: function(timestamp) {
        let r = this.parent();
        if (r) {
            this._completer.update();
        }
        return r;
    },

    _onKeyPress: function(o, e) {
        let sym = e.get_key_symbol();

        if (sym == Clutter.Return || sym == Clutter.KP_Enter) {
            this.popModal();
            this._run(o.get_text());
            if (!this._commandError) {
                this.close();
            } else {
                if (!this.pushModal())
                    this.close();
            }
            return true;
        } else if (sym == Clutter.Escape) {
            this.close();
            return true;
        } else if (sym == Clutter.Tab) {
            let text = o.get_text(),
                postfix = this._getCompletion(text);

            if (postfix != null && postfix.length > 0) {
                o.insert_text(postfix, -1);
                o.set_cursor_position(text.length + postfix.length);
            }
            return true;
        }
        return false;
    },

    _getCompletion: function(text) {
        return this._completer.getCompletion(text);
    },

    _run : function(input) {
        this._commandError = false;

        if (input) {
            let socketDir = settings.get_string(SETTINGS_CUSTOM_SOCKET_DIR_KEY),
                socketFile = GLib.build_filenamev([socketDir, input]);
            if (Gio.file_new_for_path(socketFile).query_exists(null)) {
                this._showError('Emacs server ' + input + ' is already running');
                return;
            }

            try {
                let venvDir,
                    venvFile;

                venvDir = settings.get_string(SETTINGS_VIRTUAL_ENVIRONMENT_DIR_KEY);
                venvDir = _expandPath(venvDir);
                venvFile = GLib.build_filenamev([venvDir, input + '.sh']);

                if (Gio.file_new_for_path(venvFile).query_exists(null)) {
                    Util.spawn(['bash', '-c',
                                'source ' + venvFile + '; emacs --daemon=' + input+''])
                } else {
                    Util.spawn(['emacs', '--daemon=' + input])
                }
            } catch (e) {
                this._showError(e.message);
            }
        }
    },
    _showError : function(message) {
        this._commandError = true;
        this._errorMessage.set_text(message);

        if (!this._errorBox.visible) {
            let [errorBoxMinHeight, errorBoxNaturalHeight] = this._errorBox.get_preferred_height(-1);

            let parentActor = this._errorBox.get_parent();
            Tweener.addTween(parentActor, {
                height: parentActor.height + errorBoxNaturalHeight,
                time: DIALOG_GROW_TIME,
                transition: 'easeOutQuad',
                onComplete: Lang.bind(this,
                                      function() {
                                          parentActor.set_height(-1);
                                          this._errorBox.show();
                                      })
            });
        }
    },
    open: function() {
        this._errorBox.hide();
        this._entryText.set_text('');
        this._commandError = false;
        this.parent();
    }
});


function enable() {
    let ret = GLib.spawn_sync(null, ['/usr/bin/id', '-u'], null, 0, null),
        uid = (''+ret[1]).replace(/\s+$/, '');

    defaultSocketDir = '/tmp/emacs' + uid;

    emStatusButton = new EmacsStatusButton();
    emRunDialog = new EmacsRunDialog();
    Main.panel.addToStatusArea('emacs-manager', emStatusButton)
}

function disable() {
    emStatusButton.destroy();
    emRunDialog.destroy();

    defaultSocketDir = undefined;
    emStatusButton = undefined;
    emRunDialog = undefined;
}

function init() {
    settings = Convenience.getSettings();
}
