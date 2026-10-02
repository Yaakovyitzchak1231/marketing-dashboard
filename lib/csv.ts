/**
 * Triggers a download of the provided data as a CSV file.
 *
 * @param filename - The name of the downloaded file (without .csv extension)
 * @param headers - Array of column headers
 * @param data - Array of row data (each row is an array of string/number/null)
 */
export function exportToCsv(filename: string, headers: string[], data: (string | number | null | undefined)[][]) {
  const sanitize = (val: string | number | null | undefined) => {
    if (val === null || val === undefined) return ''
    const str = String(val)
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  const csvContent = [
    headers.map(sanitize).join(','),
    ...data.map(row => row.map(sanitize).join(','))
  ].join('\n')

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.setAttribute('href', url)
  link.setAttribute('download', `${filename}.csv`)
  link.style.visibility = 'hidden'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
