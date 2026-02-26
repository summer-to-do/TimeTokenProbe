import "./globals.css";

export const metadata = {
  title: "TimeTokenProbe",
  description: "探索人机对话中的时间性交互。"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
