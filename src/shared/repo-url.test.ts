import { describe, expect, it } from "vitest"
import { checkRepoUrl } from "./repo-url"

describe("checkRepoUrl", () => {
  it("accepts an HTTPS repository URL and derives the name", () => {
    expect(checkRepoUrl("https://github.ibm.com/chipdev/core-rtl")).toEqual({
      ok: true,
      name: "core-rtl",
    })
  })

  it("strips a trailing .git and surrounding whitespace", () => {
    expect(checkRepoUrl("  https://github.ibm.com/a/b.git  ")).toEqual({
      ok: true,
      name: "b",
    })
  })

  it("rejects SSH URLs with a dedicated reason", () => {
    expect(checkRepoUrl("git@github.ibm.com:a/b.git")).toEqual({
      ok: false,
      reason: "ssh",
    })
    expect(checkRepoUrl("ssh://git@github.ibm.com/a/b")).toEqual({
      ok: false,
      reason: "ssh",
    })
  })

  it("rejects empty input, plain HTTP and URLs without org/repo", () => {
    expect(checkRepoUrl("")).toEqual({ ok: false, reason: "empty" })
    expect(checkRepoUrl("http://github.ibm.com/a/b")).toEqual({
      ok: false,
      reason: "invalid",
    })
    expect(checkRepoUrl("https://github.ibm.com/a")).toEqual({
      ok: false,
      reason: "invalid",
    })
    expect(checkRepoUrl("not a url")).toEqual({
      ok: false,
      reason: "invalid",
    })
  })
})
