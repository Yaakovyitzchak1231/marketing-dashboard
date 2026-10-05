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
const { pushMock, replaceMock, pathnameMock, store } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  pathnameMock: vi.fn(),
  store: { params: new URLSearchParams() },
}))

export function setSearchParams(queryString: string): void {
  store.params = new URLSearchParams(queryString)
}

export function currentSearchParams(): URLSearchParams {
  return store.params
}

/** The URLs the component navigated to, most recent last. */
export function replaceCalls(): string[] {
  return replaceMock.mock.calls.map((call) => String(call[0]))
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
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
  pathnameMock.mockReturnValue('/')
  store.params = new URLSearchParams()
})
