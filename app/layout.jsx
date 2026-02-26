import "./globals.css";

export const metadata = {
  title: "TimeTokenProbe",
  description: "Explore temporal interaction in Human–LLM conversations."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
