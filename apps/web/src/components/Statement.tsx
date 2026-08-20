import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatBRL } from "../lib/money";

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

export function Statement() {
  const query = useInfiniteQuery({
    queryKey: ["account", "statement"],
    queryFn: ({ pageParam }) => api.statement(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const entries = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="card" aria-labelledby="statement-title">
      <h2 id="statement-title" className="mb-4 text-lg font-semibold text-white">
        Extrato
      </h2>

      {query.isPending && <p className="text-slate-400">Carregando...</p>}
      {query.isError && <p className="text-rose-400">Não foi possível carregar o extrato.</p>}
      {query.isSuccess && entries.length === 0 && (
        <p className="text-slate-400">Nenhuma movimentação ainda.</p>
      )}

      <ul className="divide-y divide-slate-800">
        {entries.map((entry) => {
          const isCredit = entry.direction === "credit";
          return (
            <li key={entry.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-200">
                  {entry.description ?? (entry.type === "deposit" ? "Depósito" : "Transferência")}
                </p>
                <p className="text-xs text-slate-500">{dateFormatter.format(new Date(entry.createdAt))}</p>
              </div>
              <span
                className={`shrink-0 font-mono text-sm tabular-nums ${isCredit ? "text-emerald-400" : "text-slate-300"}`}
              >
                {isCredit ? "+" : "−"} {formatBRL(entry.amountCents)}
              </span>
            </li>
          );
        })}
      </ul>

      {query.hasNextPage && (
        <button
          type="button"
          className="btn-ghost mt-4 w-full"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? "Carregando..." : "Carregar mais"}
        </button>
      )}
    </section>
  );
}
