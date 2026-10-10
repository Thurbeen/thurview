# relay

A small webhook relay: it accepts signed events, stores them in an outbox and
delivers each one to every subscriber, retrying with backoff.

This repository is a sanitized fixture for thurview's terminal proof of concept.
