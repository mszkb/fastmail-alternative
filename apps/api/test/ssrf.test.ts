import { describe, expect, it } from 'vitest'
import { isPublicIp, assertPublicHost, PrivateHostError } from '@fma/shared/ssrf'

describe('isPublicIp (IPv4)', () => {
  it('allows public addresses', () => {
    expect(isPublicIp('93.184.216.34')).toBe(true)
    expect(isPublicIp('8.8.8.8')).toBe(true)
    expect(isPublicIp('1.1.1.1')).toBe(true)
  })

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.8.8.8', 'loopback range'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.1.1', 'link-local'],
    ['0.0.0.0', 'this-network'],
    ['100.64.0.1', 'CGNAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
  ])('blocks %s (%s)', (address) => {
    expect(isPublicIp(address)).toBe(false)
  })

  it('does not over-block neighboring ranges', () => {
    expect(isPublicIp('172.32.0.1')).toBe(true) // outside 172.16/12
    expect(isPublicIp('192.169.1.1')).toBe(true) // outside 192.168/16
    expect(isPublicIp('11.0.0.1')).toBe(true) // outside 10/8
  })

  it('rejects malformed addresses', () => {
    expect(isPublicIp('999.1.1.1')).toBe(false)
    expect(isPublicIp('not-an-ip')).toBe(false)
  })
})

describe('isPublicIp (IPv6)', () => {
  it('allows public addresses', () => {
    expect(isPublicIp('2606:4700::1111')).toBe(true)
    expect(isPublicIp('2a01:4f8::1')).toBe(true)
  })

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fd00::1', 'unique-local'],
    ['fc00::1', 'unique-local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'ipv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'ipv4-mapped private'],
    ['2001:db8::1', 'documentation'],
    ['2002:a00:1::1', '6to4 of 10.0.0.1'],
    ['2002:7f00:1::', '6to4 of 127.0.0.1'],
    ['2002:c0a8:101::1', '6to4 of 192.168.1.1'],
    ['2002:a9fe:a9fe::1', '6to4 of 169.254.169.254'],
    ['2002::1', '6to4 of 0.0.0.0'],
  ])('blocks %s (%s)', (address) => {
    expect(isPublicIp(address)).toBe(false)
  })

  it('allows ipv4-mapped public addresses', () => {
    expect(isPublicIp('::ffff:8.8.8.8')).toBe(true)
  })

  it('allows 6to4 addresses of public IPv4 addresses', () => {
    expect(isPublicIp('2002:808:808::1')).toBe(true) // 8.8.8.8
    expect(isPublicIp('2002:5db8:d822::1')).toBe(true) // 93.184.216.34
  })
})

describe('assertPublicHost', () => {
  const lookup = (addresses: { address: string; family: number }[]) => async (host: string) => {
    if (host === 'unresolvable.example') return []
    return addresses
  }

  it('passes for public resolutions', async () => {
    await expect(
      assertPublicHost('mail.example.com', lookup([{ address: '93.184.216.34', family: 4 }])),
    ).resolves.toBeTruthy()
  })

  it('blocks when any resolved address is private (DNS rebinding defense)', async () => {
    await expect(
      assertPublicHost(
        'evil.example',
        lookup([
          { address: '93.184.216.34', family: 4 },
          { address: '192.168.0.10', family: 4 },
        ]),
      ),
    ).rejects.toBeInstanceOf(PrivateHostError)
  })

  it('blocks when unresolvable', async () => {
    await expect(assertPublicHost('unresolvable.example', lookup([]))).rejects.toBeInstanceOf(
      PrivateHostError,
    )
  })

  it('validates literal IP addresses without DNS', async () => {
    await expect(assertPublicHost('127.0.0.1', lookup([]))).rejects.toBeInstanceOf(PrivateHostError)
    await expect(assertPublicHost('8.8.8.8', lookup([]))).resolves.toBeTruthy()
  })
})
