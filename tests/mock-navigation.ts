import { vi, beforeEach } from 'vitest'

/**
 * The App Router hooks `next/navigation` exposes, as a mock every suite can
 * drive. The campaign table reads and writes the URL, so without this the
 * component throws `invariant expected app router to be mounted` and no render
 * test can run at all.
 *
 * `setSearchParams` is the important part: the mock keeps a real
 * `URLSearchParams` as its backing store rather than returning a stub, so a test
 * can assert that the table PRESERVES params it does not own instead of only
 * asserting what it wrote. `toString()` returning a hardcoded '' would make
 * every such test pass for the wrong reason.
 */
const { pushMock, replaceMock, refreshMock, pathnameMock, store } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  refreshMock: vi.fn(),
  pathnameMock: vi.fn(),
  store: { params: new URLSearchParams() },
}))

export function setSearchParams(queryString: string): void {
  store.params = new URLSearchParams(queryString)
}

/** What usePathname() returns until the next test starts (default '/'). */
export function setPathname(path: string): void {
  pathnameMock.mockReturnValue(path)
}

export function currentSearchParams(): URLSearchParams {
  return store.params
}

/** The URLs the component navigated to, most recent last. */
export function replaceCalls(): string[] {
  return replaceMock.mock.calls.map((call) => String(call[0]))
}

/** How many times router.refresh() was called since the last test started. */
export function refreshCount(): number {
  return refreshMock.mock.calls.length
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
    refresh: refreshMock,
  }),
  usePathname: () => pathnameMock(),
  useSearchParams: () => ({
    get: (key: string) => store.params.get(key),
    toString: () => store.params.toString(),
  }),
}))

beforeEach(() => {
  pushMock.mockClear()
  replaceMock.mockClear()
  refreshMock.mockClear()
  pathnameMock.mockReturnValue('/')
  store.params = new URLSearchParams()
})
