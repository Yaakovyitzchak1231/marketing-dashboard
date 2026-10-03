import { vi, beforeEach } from "vitest"

const { pushMock, replaceMock, pathnameMock, searchParamsGetMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  pathnameMock: vi.fn(),
  searchParamsGetMock: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
  usePathname: () => pathnameMock(),
  useSearchParams: () => ({
    get: searchParamsGetMock,
    toString: () => "",
  }),
}))

beforeEach(() => {
  pushMock.mockClear()
  replaceMock.mockClear()
  pathnameMock.mockReturnValue("/")
  searchParamsGetMock.mockReturnValue(null)
})
