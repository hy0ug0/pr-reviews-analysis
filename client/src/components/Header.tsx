export function Header() {
  return (
    <header className="mb-8">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
          <svg
            className="w-6 h-6 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
            />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">
          PR Reviews Analysis
        </h1>
      </div>
      <p className="text-gray-500 dark:text-slate-400 ml-[52px]">
        Analyze code review activity across your team
      </p>
    </header>
  );
}
