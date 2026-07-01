import type { Metadata } from 'next';
import { ThemeProvider } from 'next-themes';
import NavBar from '@/components/NavBar';
import { Inter } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { getAppTitle } from '@/lib/config/app';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: getAppTitle(),
  description: 'Order and inventory intelligence',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                if (!sessionStorage.getItem('theme_auto_started')) {
                  sessionStorage.setItem('theme_auto_started', 'true');
                  localStorage.setItem('theme', 'dark');
                }
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans bg-gray-50 dark:bg-surface text-gray-900 dark:text-text-primary antialiased min-h-screen`}>
        <ClerkProvider>
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
            <NavBar />
            {children}
          </ThemeProvider>
        </ClerkProvider>
        <Analytics />
      </body>
    </html>
  );
}
