# Records the proof of concept from the real TUI, sandboxed by demo.sh:
#   examples/terminal-poc/demo.sh clean && examples/terminal-poc/demo.sh --setup --seed
#   vhs examples/terminal-poc/demo.tape
# VHS cannot send F-keys or clicks, so the pane is opened from the Ctrl+P
# palette and the tour is by keyboard; the tests drive the mouse. A screenshot
# is taken a moment after its line runs, hence the pause after each.
Output examples/terminal-poc/media/terminal-poc.gif

Set Shell bash
Set FontSize 14
Set Width 1600
Set Height 900
Set Padding 8
Set Framerate 12
Set TypingSpeed 60ms

Hide
Type "examples/terminal-poc/demo.sh" Enter
Wait+Screen@60s /Quit/
Sleep 500ms
# Off camera: the run grant, in thurbox's own settings, the way you give it.
Ctrl+P
Sleep 600ms
Type "settings"
Sleep 600ms
Enter
Sleep 800ms
Type "]"
Sleep 800ms
Type "jjjjjjjj"
Sleep 500ms
Type "t"
Sleep 500ms
Escape
Sleep 500ms
Show
Sleep 1s
Ctrl+P
Sleep 600ms
Type "thurview"
Sleep 600ms
Enter
Sleep 2s
Screenshot examples/terminal-poc/media/01-document-map-inspector.png
Sleep 1.5s
Type "]"
Sleep 800ms
Type "n"
Sleep 1.5s
Screenshot examples/terminal-poc/media/02-anchor-peek.png
Sleep 1.5s
Type "t"
Sleep 1.5s
Type "c"
Sleep 800ms
Type "Should a replay keep its attempt count?"
Sleep 800ms
Enter
Sleep 2.5s
Screenshot examples/terminal-poc/media/03-comment-thread.png
Sleep 1.5s
Space
Sleep 3.2s
Screenshot examples/terminal-poc/media/04-flow-playing.png
Sleep 1.5s
Sleep 5s
Type "R"
Sleep 800ms
Tab
Sleep 500ms
Type "the replay question first"
Sleep 1.5s
Screenshot examples/terminal-poc/media/05-submit-review.png
Sleep 1.5s
Escape
Sleep 1s
# Hidden: the shell it returns to prints local paths.
Hide
Ctrl+Q
Sleep 500ms
