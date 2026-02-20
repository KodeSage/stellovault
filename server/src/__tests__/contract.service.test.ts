import {
    TransactionBuilder,
    Keypair,
    SorobanRpc,
    xdr,
    Networks,
    Account,
    Transaction,
    SorobanDataBuilder,
    Operation,
    Asset,
} from "@stellar/stellar-sdk";

/* ---------- deterministic keypairs ---------- */

const FEE_PAYER = Keypair.random();
const USER = Keypair.random();
const FAKE_CONTRACT_ID =
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/* ---------- mock env (no external refs → safe to hoist) ---------- */

jest.mock("../config/env", () => ({
    env: {
        stellar: {
            horizonUrl: "https://horizon-testnet.stellar.org",
            rpcUrl: "https://soroban-testnet.stellar.org",
            networkPassphrase: "Test SDF Network ; September 2015",
        },
        feePayer: { publicKey: "", secretKey: "" },
    },
}));

import { env } from "../config/env";
import { ContractService } from "../services/contract.service";

/* ---------- per-test mock servers ---------- */

let service: ContractService;
let mockLoadAccount: jest.Mock;
let mockSimulateTransaction: jest.Mock;
let mockSendTransaction: jest.Mock;
let mockGetTransaction: jest.Mock;

beforeAll(() => {
    (env.feePayer as any).publicKey = FEE_PAYER.publicKey();
    (env.feePayer as any).secretKey = FEE_PAYER.secret();
});

beforeEach(() => {
    mockLoadAccount = jest.fn();
    mockSimulateTransaction = jest.fn();
    mockSendTransaction = jest.fn();
    mockGetTransaction = jest.fn();

    service = new ContractService();

    (service as any).horizonServer = { loadAccount: mockLoadAccount };
    (service as any).rpcServer = {
        simulateTransaction: mockSimulateTransaction,
        sendTransaction: mockSendTransaction,
        getTransaction: mockGetTransaction,
    };
});

/* ---------- helpers ---------- */

function makeFakeAccount(publicKey: string, seq = "100") {
    return new Account(publicKey, seq);
}

function buildSuccessSimulation(): SorobanRpc.Api.SimulateTransactionSuccessResponse {
    return {
        _parsed: true,
        id: "sim-1",
        latestLedger: 1000,
        events: [],
        minResourceFee: "100000",
        cost: { cpuInsns: "1000000", memBytes: "100000" },
        transactionData: new SorobanDataBuilder(),
        result: { auth: [], retval: xdr.ScVal.scvBool(true) },
    };
}

function buildSignedXDR(): string {
    const account = makeFakeAccount(FEE_PAYER.publicKey());
    const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
    })
        .addOperation(
            Operation.payment({
                destination: USER.publicKey(),
                asset: Asset.native(),
                amount: "10",
            }),
        )
        .setTimeout(30)
        .build();

    tx.sign(FEE_PAYER);
    return tx.toXDR();
}

/* ---------- suites ---------- */

describe("ContractService", () => {
    /* ---- buildContractInvokeXDR ---- */

    describe("buildContractInvokeXDR", () => {
        it("returns a valid base64-encoded XDR signed by the fee payer", async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeAccount(FEE_PAYER.publicKey()),
            );
            mockSimulateTransaction.mockResolvedValue(
                buildSuccessSimulation(),
            );

            const xdrString = await service.buildContractInvokeXDR(
                FAKE_CONTRACT_ID,
                "transfer",
                [xdr.ScVal.scvBool(true)],
                USER.publicKey(),
            );

            expect(typeof xdrString).toBe("string");

            const decoded = TransactionBuilder.fromXDR(
                xdrString,
                Networks.TESTNET,
            );
            expect(decoded).toBeDefined();
            expect(decoded.signatures.length).toBeGreaterThanOrEqual(1);
        });

        it("loads the fee payer account from Horizon", async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeAccount(FEE_PAYER.publicKey()),
            );
            mockSimulateTransaction.mockResolvedValue(
                buildSuccessSimulation(),
            );

            await service.buildContractInvokeXDR(
                FAKE_CONTRACT_ID,
                "deposit",
                [],
                USER.publicKey(),
            );

            expect(mockLoadAccount).toHaveBeenCalledWith(
                FEE_PAYER.publicKey(),
            );
        });

        it("sets the user as the operation source", async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeAccount(FEE_PAYER.publicKey()),
            );
            mockSimulateTransaction.mockResolvedValue(
                buildSuccessSimulation(),
            );

            const xdrString = await service.buildContractInvokeXDR(
                FAKE_CONTRACT_ID,
                "transfer",
                [],
                USER.publicKey(),
            );

            const decoded = TransactionBuilder.fromXDR(
                xdrString,
                Networks.TESTNET,
            ) as Transaction;

            const op = decoded.operations[0];
            expect(op.source).toBe(USER.publicKey());
        });

        it("uses the fee payer as the outer transaction source", async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeAccount(FEE_PAYER.publicKey()),
            );
            mockSimulateTransaction.mockResolvedValue(
                buildSuccessSimulation(),
            );

            const xdrString = await service.buildContractInvokeXDR(
                FAKE_CONTRACT_ID,
                "transfer",
                [],
                USER.publicKey(),
            );

            const decoded = TransactionBuilder.fromXDR(
                xdrString,
                Networks.TESTNET,
            ) as Transaction;

            expect(decoded.source).toBe(FEE_PAYER.publicKey());
        });

        it("throws when simulation returns an error", async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeAccount(FEE_PAYER.publicKey()),
            );

            mockSimulateTransaction.mockResolvedValue({
                _parsed: true,
                id: "sim-err",
                latestLedger: 1000,
                events: [],
                error: "host invocation failed",
            } satisfies SorobanRpc.Api.SimulateTransactionErrorResponse);

            await expect(
                service.buildContractInvokeXDR(
                    FAKE_CONTRACT_ID,
                    "bad_method",
                    [],
                    USER.publicKey(),
                ),
            ).rejects.toThrow("Simulation failed");
        });
    });

    /* ---- simulateCall ---- */

    describe("simulateCall", () => {
        it("decodes a scalar ScVal return value", async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeAccount(FEE_PAYER.publicKey()),
            );

            const sim = buildSuccessSimulation();
            sim.result = { auth: [], retval: xdr.ScVal.scvU32(42) };
            mockSimulateTransaction.mockResolvedValue(sim);

            const result = await service.simulateCall(
                FAKE_CONTRACT_ID,
                "get_value",
                [],
            );

            expect(result).toBe(42);
        });

        it("returns null when simulation has no return value", async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeAccount(FEE_PAYER.publicKey()),
            );

            const sim = buildSuccessSimulation();
            delete (sim as any).result;
            mockSimulateTransaction.mockResolvedValue(sim);

            const result = await service.simulateCall(
                FAKE_CONTRACT_ID,
                "do_something",
                [],
            );

            expect(result).toBeNull();
        });

        it("throws on simulation error", async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeAccount(FEE_PAYER.publicKey()),
            );
            mockSimulateTransaction.mockResolvedValue({
                _parsed: true,
                id: "sim-err",
                latestLedger: 1000,
                events: [],
                error: "contract trapped",
            } satisfies SorobanRpc.Api.SimulateTransactionErrorResponse);

            await expect(
                service.simulateCall(FAKE_CONTRACT_ID, "bad_fn", []),
            ).rejects.toThrow("Simulation failed: contract trapped");
        });
    });

    /* ---- submitXDR ---- */

    describe("submitXDR", () => {
        it("returns hash and SUCCESS status on a healthy submission", async () => {
            const txXDR = buildSignedXDR();

            mockSendTransaction.mockResolvedValue({
                status: "PENDING",
                hash: "abc123",
                latestLedger: 1000,
                latestLedgerCloseTime: 1000,
            } satisfies SorobanRpc.Api.SendTransactionResponse);

            mockGetTransaction
                .mockResolvedValueOnce({
                    status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
                    latestLedger: 1001,
                    latestLedgerCloseTime: 1001,
                    oldestLedger: 900,
                    oldestLedgerCloseTime: 900,
                } satisfies SorobanRpc.Api.GetMissingTransactionResponse)
                .mockResolvedValueOnce({
                    status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
                    latestLedger: 1002,
                    latestLedgerCloseTime: 1002,
                    oldestLedger: 900,
                    oldestLedgerCloseTime: 900,
                    ledger: 1002,
                    createdAt: 1000,
                    applicationOrder: 1,
                    feeBump: false,
                    envelopeXdr: {} as any,
                    resultXdr: {} as any,
                    resultMetaXdr: {} as any,
                } satisfies SorobanRpc.Api.GetSuccessfulTransactionResponse);

            const result = await service.submitXDR(txXDR);

            expect(result).toEqual({ hash: "abc123", status: "SUCCESS" });
            expect(mockGetTransaction).toHaveBeenCalledTimes(2);
        });

        it("throws immediately when sendTransaction returns ERROR", async () => {
            const txXDR = buildSignedXDR();

            mockSendTransaction.mockResolvedValue({
                status: "ERROR",
                hash: "bad",
                latestLedger: 1000,
                latestLedgerCloseTime: 1000,
            });

            await expect(service.submitXDR(txXDR)).rejects.toThrow(
                "Transaction rejected by network",
            );
        });

        it("throws when the transaction fails on-chain", async () => {
            const txXDR = buildSignedXDR();

            mockSendTransaction.mockResolvedValue({
                status: "PENDING",
                hash: "fail-hash",
                latestLedger: 1000,
                latestLedgerCloseTime: 1000,
            });

            mockGetTransaction.mockResolvedValue({
                status: SorobanRpc.Api.GetTransactionStatus.FAILED,
                latestLedger: 1002,
                latestLedgerCloseTime: 1002,
                oldestLedger: 900,
                oldestLedgerCloseTime: 900,
                ledger: 1002,
                createdAt: 1000,
                applicationOrder: 1,
                feeBump: false,
                envelopeXdr: {} as any,
                resultXdr: {} as any,
                resultMetaXdr: {} as any,
            } satisfies SorobanRpc.Api.GetFailedTransactionResponse);

            await expect(service.submitXDR(txXDR)).rejects.toThrow(
                "Transaction failed on-chain",
            );
        });
    });
});
