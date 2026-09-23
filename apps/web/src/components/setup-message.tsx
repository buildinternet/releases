export function SetupMessage({ message, steps }: { message: string; steps: string[] }) {
  return (
    <div className="max-w-lg mx-auto mt-24 px-6">
      <div className="border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 rounded-lg p-6">
        <div className="flex items-start gap-3">
          <div className="text-amber-500 text-lg leading-none mt-0.5">&#9888;</div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-stone-900 dark:text-stone-100 text-sm mb-1">
              Setup required
            </h2>
            <p className="text-sm text-stone-600 dark:text-stone-400 mb-4">{message}</p>
            <pre className="bg-stone-900 dark:bg-stone-950 text-stone-100 text-xs rounded-md p-4 overflow-x-auto whitespace-pre-wrap break-words">
              {steps.map((step, i) => (
                <span key={i}>
                  {step.startsWith("#") ? (
                    <span className="text-stone-500">{step}</span>
                  ) : (
                    <span className="text-green-400">$ {step}</span>
                  )}
                  {i < steps.length - 1 && "\n"}
                </span>
              ))}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
