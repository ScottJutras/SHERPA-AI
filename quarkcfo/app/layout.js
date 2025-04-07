import './globals.css';

export const metadata = {
  title: 'QuarkCFO',
  description: 'Your quantum-powered financial orb for contractors and SMBs.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}