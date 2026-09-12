# Security surfaces

A generic security pass produces generic findings. The checklist has to come
from what the change actually touches, so derive it from the diff and say what
you derived it from.

## How to derive it

1. List the surfaces the diff crosses. A surface is a place where the change
   meets something it does not control - input it did not produce, a file
   system, another process, a network peer, a platform API, a log.
2. For each surface, take its questions from the table below.
3. Ask each question against the code at the pinned head, not against the
   hunk. A missing cleanup path is invisible in a diff that only adds lines.
4. Anchor every finding to the line that answers it.
5. **State the result explicitly, findings or none.** "No security findings"
   is a result; an absent section is not one, and the maintainer cannot tell
   the two apart.

## Surfaces and their questions

| The change touches         | Ask                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Text that reaches a model  | Prompt injection - whose text is it, what can it make the agent do, what is quoted versus interpreted                                        |
| Temporary files            | Predictable name, permissions at creation, symlink races, TOCTOU between check and use, cleanup on every error path as well as the happy one |
| Attacker-controlled names  | Path traversal, absolute paths, shell metacharacters, leading dashes read as flags, Unicode that normalises to something else                |
| Reading untrusted bytes    | Unbounded reads, allocation from a length the input chose, decompression ratios, what happens at the size limit rather than below it         |
| Running another process    | Argument construction, quoting per platform, whether a shell is involved at all, what the environment carries, working directory             |
| Process or PTY lifetime    | Orphans on error, exit status that can be forged or lost, signals, what happens when the child outlives the parent                           |
| Logs and telemetry         | What reaches a log that should not - secrets, tokens, file contents, personal data - and whether log lines can be forged by input            |
| Platform branches          | Each branch checked separately; a guard that holds on Linux and not on Windows is the common shape                                           |
| Authentication or identity | What is trusted, what is verified, what a caller can assert about itself                                                                     |
| Serialised data            | Deserialisation of attacker-controlled shapes, schema validation before use, defaults that silently accept                                   |

## Two worked examples

**A clipboard copy through a temporary file.** Surfaces: text that reaches a
model, temporary files, attacker-controlled names, unbounded reads, running
another process, platform branches, logs. Which yields, concretely - is the
temp file name predictable; what mode is it created with; is there a window
between creating and writing it; is it removed when the copy fails and not
only when it succeeds; can the copied text be read back by another user; does
the platform helper get its argument as an argument or through a shell; does
the content reach a log.

**A window lifecycle change that spawns a process.** Surfaces: running another
process, process lifetime, attacker-controlled names, platform branches.
Which yields - how the command line is built and escaped on each platform;
whether a window name is interpolated into it; whether the child is reaped;
whether its exit status can be forged by something the child does not control;
what the code does when the platform branch it was not written for runs.

The pattern in both: the surfaces come from the diff, the questions come from
the surfaces, and the answers come from the code at head.
