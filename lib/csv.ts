/**
 * Build a CSV file from headers and rows, and hand it to the browser as a
 * download.
 *
 * Two rules, both about not lying to the reader:
 *
 *   - An absent value is an EMPTY CELL, never a 0. `null` means the source did
 *     not report the figure, and a 0 in the file would assert a measurement
 *     nobody made. This is the same rule lib/format.ts applies on screen.
 *   - A value beginning `=`, `+`, `-` or `@` is prefixed with a single quote so
 *     a spreadsheet reads it as text. Idea names, angle names and cost notes are
 *     all human-entered free text, and an unescaped one becomes a formula the
 *     moment the file is opened.
 *
 * Values containing a comma, quote, CR or LF are quoted, with inner quotes
 * doubled, so a name like `Q3 "jewelry", IRS` survives as one cell.
 *
 * @param filename - the download name, without the .csv extension
 * @param headers - column headers
 * @param data - rows of string, number, null or undefined
 */
export function exportToCsv(
  filename: string,
  headers: string[],
  data: (string | number | null | undefined)[][],
): void {
  const cell = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) return ''
    let str = String(value)
    if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`
    if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
    return str
  }

  const csvContent = [
    headers.map(cell).join(','),
    ...data.map((row) => row.map(cell).join(',')),
  ].join('\r\n')

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
