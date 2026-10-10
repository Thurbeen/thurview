# Records the proof of concept from the real TUI, sandboxed by demo.sh:
#   vhs examples/terminal-poc/demo.tape
# VHS cannot send F-keys, so the pane is opened from the Ctrl+P palette. A
# screenshot is taken a moment after its line runs, hence the pause after each.
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
Type "n"
Sleep 1s
Tab
Sleep 500ms
Type "jjj"
Sleep 1.5s
Space
Sleep 3.2s
Screenshot examples/terminal-poc/media/04-flow-playing.png
Sleep 1.5s
Sleep 6s
Space
Sleep 1s
# Hidden: the shell it returns to prints local paths.
Hide
Ctrl+Q
Sleep 500ms
