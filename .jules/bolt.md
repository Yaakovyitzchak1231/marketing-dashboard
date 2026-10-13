## 2024-10-13 - O(n) Array Method Replacements
**Learning:** To reduce memory overhead and garbage collection in Node.js/Next.js API routes, avoid chaining array methods like `.filter().sort()[0]` to find minimums/maximums or when aggregating large datasets into Sets.
**Action:** Instead, iterate directly over the source arrays with a single `for...of` loop to ensure O(n) time complexity and eliminate intermediate array allocations.
