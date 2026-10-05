import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: 'Orvia — considered goods for pets, kids, style & everyday life', template: '%s · Orvia' },
  description: 'Orvia is a curated marketplace for pets, kids, fashion and smart everyday gadgets, with tracked delivery to the USA, Canada and India and easy returns.',
  applicationName: 'Orvia',
  openGraph: { type: 'website', siteName: 'Orvia', title: 'Orvia', description: 'Considered goods for pets, kids, style and everyday life.' },
  icons: { icon: '/icon.svg' },
  robots: { index: true, follow: true },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: [{ media: '(prefers-color-scheme: light)', color: '#fbf9f5' }, { media: '(prefers-color-scheme: dark)', color: '#12110f' }] };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-paper">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
