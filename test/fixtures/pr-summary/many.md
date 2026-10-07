<!-- thurview-pr-review {"head":"aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111","state":"active","seen":"0"} -->
Next: @dev — **Confidence 2/5 · do not merge; fix the 4 blocking findings.**

[**Full review**](https://reviews.example.com/r/7/) · [Markdown export](https://reviews.example.com/r/7/feedback.md)

Four blocking bugs.

| Finding at reviewed head | Thread |
| --- | --- |
| **Blocking · Bug:** Finding 2 uses a \| pipe. | [`src/upload.ts:3`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Blocking · Bug:** Finding 5 uses a \| pipe. | [`src/upload.ts:6`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Blocking · Bug:** Finding 8 uses a \| pipe. | [`src/upload.ts:9`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Blocking · Bug:** Finding 11 uses a \| pipe. | [`src/upload.ts:12`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Non-blocking · Bug:** Finding 1 uses a \| pipe. | [`src/upload.ts:2`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Non-blocking · Bug:** Finding 4 uses a \| pipe. | [`src/upload.ts:5`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Non-blocking · Bug:** Finding 7 uses a \| pipe. | [`src/upload.ts:8`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Non-blocking · Bug:** Finding 10 uses a \| pipe. | [`src/upload.ts:11`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Nit · Bug:** Finding 0 uses a \| pipe. | [`src/upload.ts:1`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Nit · Bug:** Finding 3 uses a \| pipe. | [`src/upload.ts:4`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Nit · Bug:** Finding 6 uses a \| pipe. | [`src/upload.ts:7`](https://github.com/acme/web/pull/7#discussion_r101) |
| **Nit · Bug:** Finding 9 uses a \| pipe. | [`src/upload.ts:10`](https://github.com/acme/web/pull/7#discussion_r101) |

First review: 12 new findings.

<details>
<summary>Change and risks</summary>

**Change:** Retries a failed upload.

**Risk**

- Uploads retry on a 4xx.

</details>

Reviewed `aaaa111` · REVIEWED_AT

— the agent
