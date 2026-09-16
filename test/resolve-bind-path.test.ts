import { describe, it, expect } from 'vitest'
import { resolveBindPath } from '../webapp/src/api'

describe('resolveBindPath', () => {
  const knownPaths = [
    'environment.depth.belowTransducer',
    'bar.foo.thing',
    'electrical.batteries.house.voltage'
  ]

  it('treats an exact known path as-is, with no extra field', () => {
    expect(
      resolveBindPath('environment.depth.belowTransducer', knownPaths)
    ).toEqual({
      skPath: 'environment.depth.belowTransducer',
      fieldPath: []
    })
  })

  it('splits a manually-extended bind at the longest known SK path prefix', () => {
    expect(resolveBindPath('bar.foo.thing.value.name', knownPaths)).toEqual({
      skPath: 'bar.foo.thing',
      fieldPath: ['value', 'name']
    })
  })

  it('resolves a single extra segment', () => {
    expect(resolveBindPath('bar.foo.thing.value', knownPaths)).toEqual({
      skPath: 'bar.foo.thing',
      fieldPath: ['value']
    })
  })

  it('never splits mid-segment (no false-positive substring prefix)', () => {
    // `bar.foo.thingamajig` is NOT an extension of `bar.foo.thing` —
    // "thing" is a substring of "thingamajig" but not a dot-segment.
    expect(resolveBindPath('bar.foo.thingamajig', knownPaths)).toEqual({
      skPath: 'bar.foo.thingamajig',
      fieldPath: []
    })
  })

  it('falls back to the literal bind when no known path matches', () => {
    expect(resolveBindPath('totally.unknown.path', knownPaths)).toEqual({
      skPath: 'totally.unknown.path',
      fieldPath: []
    })
  })

  it('falls back to the literal bind when knownPaths is empty (not loaded yet)', () => {
    expect(resolveBindPath('bar.foo.thing.value.name', [])).toEqual({
      skPath: 'bar.foo.thing.value.name',
      fieldPath: []
    })
  })

  it('returns an empty skPath/fieldPath for an empty bind', () => {
    expect(resolveBindPath('', knownPaths)).toEqual({
      skPath: '',
      fieldPath: []
    })
  })
})
