import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { api, errorMessage } from "../api/client";
import { formatBRL, parseBRLToCents } from "../lib/money";

const formSchema = z.object({
  recipientEmail: z.email("Informe um e-mail válido"),
  amountCents: z.number({ error: "Informe um valor válido, ex: 25,90" }).int().positive(),
  description: z.string().max(140).optional(),
});

export function TransferForm({ balanceCents }: { balanceCents: number | undefined }) {
  const queryClient = useQueryClient();
  const [recipientEmail, setRecipientEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  // One key per intended transfer: retries and double clicks reuse it, so the
  // server executes the transfer at most once. A new key is minted on success.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const mutation = useMutation({
    mutationFn: (input: z.infer<typeof formSchema>) => api.transfer(input, idempotencyKey),
    onSuccess: async () => {
      setRecipientEmail("");
      setAmount("");
      setDescription("");
      setIdempotencyKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = formSchema.safeParse({
      recipientEmail: recipientEmail.trim(),
      amountCents: parseBRLToCents(amount) ?? undefined,
      description: description.trim() || undefined,
    });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Dados inválidos");
      return;
    }
    if (balanceCents !== undefined && parsed.data.amountCents > balanceCents) {
      setFieldError(`Saldo disponível: ${formatBRL(balanceCents)}`);
      return;
    }
    setFieldError(null);
    mutation.mutate(parsed.data);
  }

  const error = fieldError ?? (mutation.isError ? errorMessage(mutation.error) : null);

  return (
    <form onSubmit={onSubmit} className="card space-y-4" noValidate aria-labelledby="transfer-title">
      <h2 id="transfer-title" className="text-lg font-semibold text-white">
        Nova transferência
      </h2>
      <label className="field">
        <span>E-mail do destinatário</span>
        <input
          type="email"
          value={recipientEmail}
          onChange={(e) => setRecipientEmail(e.target.value)}
          placeholder="nome@exemplo.com"
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span>Valor (R$)</span>
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0,00"
        />
      </label>
      <label className="field">
        <span>Descrição (opcional)</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={140} />
      </label>

      {error && (
        <p role="alert" className="text-sm text-rose-400">
          {error}
        </p>
      )}
      {mutation.isSuccess && (
        <p role="status" className="text-sm text-emerald-400">
          Transferência realizada.
        </p>
      )}

      <button type="submit" className="btn-primary w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Enviando..." : "Transferir"}
      </button>
    </form>
  );
}
