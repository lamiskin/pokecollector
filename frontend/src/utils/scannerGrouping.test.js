import { describe, expect, test } from 'vitest'

import {
  individualPositions,
  nextIndividualChoice,
  resolveIndividual,
  scannerGroupsIndividuallyByDefault,
} from './scannerGrouping'

const localScanner = { default_grouping: 'individual' }
const hostedScanner = { default_grouping: 'automatic' }

const untouched = count => Array.from({ length: count }, () => ({ individual: null }))

describe('scanner grouping default', () => {
  test('reads the individual default from the scanner configuration', () => {
    expect(scannerGroupsIndividuallyByDefault(localScanner)).toBe(true)
    expect(scannerGroupsIndividuallyByDefault(hostedScanner)).toBe(false)
  })

  test('falls back to automatic grouping when the configuration is missing', () => {
    expect(scannerGroupsIndividuallyByDefault(undefined)).toBe(false)
    expect(scannerGroupsIndividuallyByDefault(null)).toBe(false)
    expect(scannerGroupsIndividuallyByDefault({})).toBe(false)
  })

  test('falls back to automatic grouping for an unknown value', () => {
    expect(scannerGroupsIndividuallyByDefault({ default_grouping: 'grouped' })).toBe(false)
    expect(scannerGroupsIndividuallyByDefault({ default_grouping: null })).toBe(false)
  })
})

describe('individualPositions', () => {
  test('sends every untouched photo individually on a local scanner', () => {
    expect(individualPositions(untouched(3), localScanner)).toEqual([0, 1, 2])
  })

  test('sends no individual position for untouched photos on a hosted scanner', () => {
    expect(individualPositions(untouched(3), hostedScanner)).toEqual([])
  })

  test('lets an explicit override win on a local scanner', () => {
    const items = [{ individual: null }, { individual: false }, { individual: null }]

    expect(individualPositions(items, localScanner)).toEqual([0, 2])
  })

  test('lets an explicit override win on a hosted scanner', () => {
    const items = [{ individual: null }, { individual: true }, { individual: false }]

    expect(individualPositions(items, hostedScanner)).toEqual([1])
  })

  test('keeps explicit individual photos on a local scanner', () => {
    expect(individualPositions([{ individual: true }], localScanner)).toEqual([0])
  })

  test('treats a missing configuration as automatic grouping', () => {
    expect(individualPositions(untouched(2), undefined)).toEqual([])
    expect(individualPositions(untouched(2), { default_grouping: 'sometimes' })).toEqual([])
  })

  test('tolerates staged items without an individual flag', () => {
    expect(individualPositions([{}, { individual: true }], localScanner)).toEqual([0, 1])
    expect(individualPositions(undefined, localScanner)).toEqual([])
  })
})

describe('resolveIndividual', () => {
  test('follows the default when the photo has no explicit choice', () => {
    expect(resolveIndividual(null, localScanner)).toBe(true)
    expect(resolveIndividual(undefined, localScanner)).toBe(true)
    expect(resolveIndividual(null, hostedScanner)).toBe(false)
  })

  test('always honours an explicit choice', () => {
    expect(resolveIndividual(false, localScanner)).toBe(false)
    expect(resolveIndividual(true, hostedScanner)).toBe(true)
  })
})

describe('nextIndividualChoice', () => {
  test('flips an untouched photo away from the default', () => {
    expect(nextIndividualChoice(null, localScanner)).toBe(false)
    expect(nextIndividualChoice(null, hostedScanner)).toBe(true)
  })

  test('returns an overridden photo to the default', () => {
    expect(nextIndividualChoice(false, localScanner)).toBeNull()
    expect(nextIndividualChoice(true, hostedScanner)).toBeNull()
  })

  test('flips an explicit choice that matches the default', () => {
    expect(nextIndividualChoice(true, localScanner)).toBe(false)
    expect(nextIndividualChoice(false, hostedScanner)).toBe(true)
  })

  test('uses automatic grouping when the configuration has not loaded yet', () => {
    expect(nextIndividualChoice(null, undefined)).toBe(true)
  })
})
