<!-- thurview-pr-review {"head":"aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111","state":"active","seen":"0"} -->
Next: @dev — **Confidence 2/5 · do not merge; fix the 1 blocking finding.**

[**Full review**](https://reviews.example.com/r/7/) · [Markdown export](https://reviews.example.com/r/7/feedback.md)

One blocking bug.

| Finding at reviewed head | Thread |
| --- | --- |
| **Blocking · Bug:** The retry loop never stops on a 4xx. | [`src/upload.ts:42`](https://gitlab.example.com/acme/web/-/merge_requests/7#note_101) |

First review: 1 new finding.

<details>
<summary>Change and risks</summary>

**Change:** Retries a failed upload.

**Risk**

- Uploads retry on a 4xx.

</details>

Reviewed `aaaa111` · REVIEWED_AT

— the agent
