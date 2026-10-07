<!-- thurview-pr-review {"head":"aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111","state":"active","seen":"9"} -->
Next: @dev — **Confidence 4/5 · look at the non-blocking findings before merge.**

[**Full review**](https://reviews.example.com/r/7/) · [Markdown export](https://reviews.example.com/r/7/feedback.md)

The blocking retry bug is fixed.

| Finding at reviewed head | Thread |
| --- | --- |
| **Non-blocking · Reliability:** Timeouts lose the upload. | [`src/timeout.ts:8`](https://github.com/acme/web/pull/7#discussion_r202) |
| **Non-blocking · Tests:** The retry limit is untested. | [`test/upload.ts:12`](https://github.com/acme/web/pull/7#discussion_r101) |

<details>
<summary>Since this review: 1 resolved · 1 new · 1 still open</summary>

Counts are from this pass against the reviewed head.

</details>

<details>
<summary>Change and risks</summary>

**Change:** Retries a failed upload.

**Risk**

- Uploads retry on a 4xx.

</details>

Reviewed `aaaa111` · REVIEWED_AT

— the agent
