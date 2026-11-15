---
name: hybrid-search-implementation
description: Best practices for zero-dependency hybrid lexical and Int8 vector search
license: MIT
---

# Hybrid Search Implementation

## Core Invariants
1. **Instant Lexical First (< 0.5 ms):** Run synchronous lexical matching on keystroke 1. Never wait for async embedding models before showing exact literal ID hits.
2. **Branch-and-Bound Early Exit:** Break query token scoring as soon as `matchedTokens + remainingTokens < minCoverage`.
3. **0-Index Transposition (Damerau):** Handle adjacent transpositions across indices 0..len-2 to catch common typographical swaps (e.g. `f2a` <-> `2fa`).
4. **Pigeonhole 1-Edit Levenshtein:** For token lengths >= 4 with `|qLen - hLen| <= 1`, require first or last character equality before calculating edit distance.
5. **Int8 Cosine Similarity:** Compute dot product on normalized Int8 arrays in flat memory (~0.04 ms for 500 items).
