export const invoke = vi.fn()
export const isTauri = vi.fn(() => false)
export const core = { invoke, isTauri }
