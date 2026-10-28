import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Statement } from "../components/Statement";
import { TransferForm } from "../components/TransferForm";
import { formatBRL } from "../lib/money";

export function Dashboard() {
  const { session, signOut } = useAuth();
  const queryClient = useQueryClient();
  const balance = useQuery({ queryKey: ["account", "balance"], queryFn: api.balance });
  const [depositKey, setDepositKey] = useState(() => crypto.randomUUID());

  const deposit = useMutation({
    mutationFn: () => api.deposit(100_00, depositKey),
    onSuccess: async () => {
      setDepositKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-400">Olá,</p>
          <h1 className="text-2xl font-semibold text-white">{session?.user.name}</h1>
        </div>
        <button type="button" className="btn-ghost" onClick={signOut}>
          Sair
        </button>
      </header>

      <section className="card mb-6 bg-linear-to-br from-indigo-600/30 to-slate-900">
        <p className="text-sm text-slate-300">Saldo disponível</p>
        <p className="mt-1 font-mono text-4xl font-semibold tabular-nums text-white" aria-live="polite">
          {balance.data ? formatBRL(balance.data.balanceCents) : "—"}
        </p>
        <button
          type="button"
          className="btn-ghost mt-4"
          onClick={() => deposit.mutate()}
          disabled={deposit.isPending}
        >
          + Depositar R$ 100,00 (simulação)
        </button>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <TransferForm balanceCents={balance.data?.balanceCents} />
        <Statement />
      </div>
    </div>
  );
}
