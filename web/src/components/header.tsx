import Link from "next/link";

export function Header() {
  return (
    <header className="border-b border-stone-200 px-6 py-4 flex items-center justify-between">
      <Link href="/" className="font-bold text-lg tracking-tight text-stone-900">released</Link>
      <nav className="flex gap-5 text-sm text-stone-500">
        <Link href="/" className="hover:text-stone-700">Browse</Link>
        <Link href="/search" className="hover:text-stone-700">Search</Link>
      </nav>
    </header>
  );
}
