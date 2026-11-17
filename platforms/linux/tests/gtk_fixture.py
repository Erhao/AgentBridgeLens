"""Real GTK application used only in an isolated Xvfb / session-bus test."""
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

window = Gtk.Window(title="AgentBridgeLens desktop integration")
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
entry = Gtk.Entry()
entry.get_accessible().set_name("Message")
password = Gtk.Entry()
password.set_visibility(False)
password.set_text("secret-value-must-not-appear")
password.get_accessible().set_name("Password")
button = Gtk.Button(label="Apply")
label = Gtk.Label(label="Ready")
button.connect("clicked", lambda *_: label.set_text("Applied: " + entry.get_text()))
for widget in [entry, password, button, label]:
    box.pack_start(widget, True, True, 0)
window.add(box)
window.show_all()
GLib.idle_add(lambda: print("ready", flush=True))
Gtk.main()
