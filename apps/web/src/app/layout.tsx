import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'BusinessOS', template: '%s · BusinessOS' },
  description: 'Run your business from one place.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
