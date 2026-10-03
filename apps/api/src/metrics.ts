/**
 * Minimal dependency-free Prometheus metrics (roadmap 1.7).
 *
 * Scope for phase 1: HTTP request counters/durations and process stats.
 * Per-account sync latency, job queue length etc. follow with phase 2/3
 * once those subsystems exist.
 *
 * The endpoint is disabled unless METRICS_TOKEN is set; scraping then
 * requires `Authorization: Bearer <METRICS_TOKEN>`.
 */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

interface Histogram {
  buckets: number[]
  counts: number[]
  sum: number
  count: number
}

export class Metrics {
  private readonly counters = new Map<string, number>()
  private readonly histograms = new Map<string, Histogram>()

  inc(nameWithLabels: string, value = 1): void {
    this.counters.set(nameWithLabels, (this.counters.get(nameWithLabels) ?? 0) + value)
  }

  observe(name: string, value: number): void {
    let histogram = this.histograms.get(name)
    if (!histogram) {
      histogram = {
        buckets: DURATION_BUCKETS,
        counts: DURATION_BUCKETS.map(() => 0),
        sum: 0,
        count: 0,
      }
      this.histograms.set(name, histogram)
    }
    for (let i = 0; i < histogram.buckets.length; i += 1) {
      if (value <= (histogram.buckets[i] ?? Infinity)) {
        histogram.counts[i] = (histogram.counts[i] ?? 0) + 1
      }
    }
    histogram.sum += value
    histogram.count += 1
  }

  render(): string {
    const lines: string[] = []

    lines.push('# HELP http_requests_total Total HTTP requests.')
    lines.push('# TYPE http_requests_total counter')
    for (const [labels, value] of this.counters) {
      lines.push(`http_requests_total${labels} ${value}`)
    }

    lines.push('# HELP http_request_duration_seconds HTTP request duration in seconds.')
    lines.push('# TYPE http_request_duration_seconds histogram')
    for (const [name, histogram] of this.histograms) {
      for (let i = 0; i < histogram.buckets.length; i += 1) {
        lines.push(`${name}_bucket{le="${histogram.buckets[i]}"} ${histogram.counts[i]}`)
      }
      lines.push(`${name}_bucket{le="+Inf"} ${histogram.count}`)
      lines.push(`${name}_sum ${histogram.sum}`)
      lines.push(`${name}_count ${histogram.count}`)
    }

    lines.push('# HELP process_uptime_seconds Process uptime in seconds.')
    lines.push('# TYPE process_uptime_seconds gauge')
    lines.push(`process_uptime_seconds ${process.uptime().toFixed(3)}`)

    lines.push('# HELP process_resident_memory_bytes Resident memory in bytes.')
    lines.push('# TYPE process_resident_memory_bytes gauge')
    lines.push(`process_resident_memory_bytes ${process.memoryUsage().rss}`)

    return `${lines.join('\n')}\n`
  }
}
