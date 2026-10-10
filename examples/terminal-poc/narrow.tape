# The same pane at a narrow width, where the document, the map and the
# inspector take turns (Tab) and the map pans:
#   vhs examples/terminal-poc/narrow.tape
Output examples/terminal-poc/media/terminal-poc-narrow.gif

Set Shell bash
Set FontSize 14
Set Width 940
Set Height 760
Set Padding 8
Set Framerate 12
Set TypingSpeed 60ms

Hide
Type "examples/terminal-poc/demo.sh" Enter
Wait+Screen@60s /Quit/
Show
Sleep 1s
Ctrl+P
Sleep 600ms
Type "thurview"
Sleep 600ms
Enter
Sleep 1.5s
Tab
Sleep 1s
Screenshot examples/terminal-poc/media/06-narrow-map.png
Sleep 1.5s
Right 3
Sleep 1s
Screenshot examples/terminal-poc/media/07-narrow-map-panned.png
Sleep 1.5s
Tab
Sleep 1.2s
# Hidden: the shell it returns to prints local paths.
Hide
Ctrl+Q
Sleep 500ms
