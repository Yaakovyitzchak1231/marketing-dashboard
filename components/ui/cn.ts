import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/** tailwind-merge that knows this project's custom font sizes and radii. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['2xs', 'metric', 'metric-sm'] }],
      rounded: [{ rounded: ['control', 'card', 'input', 'sheet'] }],
      shadow: [{ shadow: ['card', 'raised', 'overlay'] }],
    },
  },
})

/** shadcn's cn(): clsx + tailwind-merge. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
