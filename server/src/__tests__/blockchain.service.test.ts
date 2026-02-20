import {
    TransactionBuilder,
    Keypair,
    Networks,
    Account,
    Transaction,
} from "@stellar/stellar-sdk";

/* ---------- deterministic keypairs ---------- */

const FEE_PAYER = Keypair.random();
const USER = Keypair.random();
const RECIPIENT = Keypair.random();

/* ---------- mock env ---------- */

jest.mock("../config/env", () => ({
    env: {
        stellar: {
            horizonUrl: "https://horizon-testnet.stellar.org",
            networkPassphrase: "Test SDF Network ; September 2015",
        },
        feePayer: { publicKey: "", secretKey: "" },
    },
}));

import { env } from "../config/env";
import { BlockchainService } from "../services/blockchain.service";

/* ---------- per-test mock server ---------- */

let service: BlockchainService;
let mockLoadAccount: jest.Mock;

beforeAll(() => {
    (env.feePayer as any).publicKey = FEE_PAYER.publicKey();
    (env.feePayer as any).secretKey = FEE_PAYER.secret();
});

beforeEach(() => {
    mockLoadAccount = jest.fn();
    service = new BlockchainService();
    (service as any).server = { loadAccount: mockLoadAccount };
});

/* ---------- helpers ---------- */

function makeFakeHorizonAccount(
    publicKey: string,
    balances: any[] = [],
    sequence = "200",
) {
    const account = new Account(publicKey, sequence);
    (account as any).balances = balances;
    return account;
}

/* ---------- suites ---------- */

describe("BlockchainService", () => {
    /* ---- getAccountBalance ---- */

    describe("getAccountBalance", () => {
        it('returns native XLM balance when assetCode is "native"', async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeHorizonAccount(USER.publicKey(), [
                    { asset_type: "native", balance: "150.0000000" },
                ]),
            );

            const balance = await service.getAccountBalance(
                USER.publicKey(),
                "native",
            );

            expect(balance).toBe("150.0000000");
            expect(mockLoadAccount).toHaveBeenCalledWith(USER.publicKey());
        });

        it('returns native XLM balance when assetCode is "XLM"', async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeHorizonAccount(USER.publicKey(), [
                    { asset_type: "native", balance: "42.0000000" },
                ]),
            );

            const balance = await service.getAccountBalance(
                USER.publicKey(),
                "XLM",
            );

            expect(balance).toBe("42.0000000");
        });

        it("returns balance for a custom asset (e.g. USDC)", async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeHorizonAccount(USER.publicKey(), [
                    { asset_type: "native", balance: "10.0000000" },
                    {
                        asset_type: "credit_alphanum4",
                        asset_code: "USDC",
                        asset_issuer: "GABCD...",
                        balance: "500.0000000",
                    },
                ]),
            );

            const balance = await service.getAccountBalance(
                USER.publicKey(),
                "USDC",
            );

            expect(balance).toBe("500.0000000");
        });

        it('returns "0" when the requested asset is not on the account', async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeHorizonAccount(USER.publicKey(), [
                    { asset_type: "native", balance: "10.0000000" },
                ]),
            );

            const balance = await service.getAccountBalance(
                USER.publicKey(),
                "BTC",
            );

            expect(balance).toBe("0");
        });

        it("defaults to native when assetCode is omitted", async () => {
            mockLoadAccount.mockResolvedValue(
                makeFakeHorizonAccount(USER.publicKey(), [
                    { asset_type: "native", balance: "99.0000000" },
                ]),
            );

            const balance = await service.getAccountBalance(USER.publicKey());

            expect(balance).toBe("99.0000000");
        });
    });

    /* ---- buildNativePayment ---- */

    describe("buildNativePayment", () => {
        it("returns valid base64 XDR signed by fee payer", async () => {
            mockLoadAccount.mockResolvedValue(
                new Account(FEE_PAYER.publicKey(), "300"),
            );

            const xdrString = await service.buildNativePayment(
                FEE_PAYER.publicKey(),
                RECIPIENT.publicKey(),
                "5",
            );

            expect(typeof xdrString).toBe("string");

            const decoded = TransactionBuilder.fromXDR(
                xdrString,
                Networks.TESTNET,
            );
            expect(decoded).toBeDefined();
            expect(decoded.signatures.length).toBe(1);
        });

        it("uses fee payer as the transaction source", async () => {
            mockLoadAccount.mockResolvedValue(
                new Account(FEE_PAYER.publicKey(), "300"),
            );

            const xdrString = await service.buildNativePayment(
                USER.publicKey(),
                RECIPIENT.publicKey(),
                "1",
            );

            const decoded = TransactionBuilder.fromXDR(
                xdrString,
                Networks.TESTNET,
            ) as Transaction;

            expect(decoded.source).toBe(FEE_PAYER.publicKey());
        });

        it("sets the from address as the operation source", async () => {
            mockLoadAccount.mockResolvedValue(
                new Account(FEE_PAYER.publicKey(), "300"),
            );

            const xdrString = await service.buildNativePayment(
                USER.publicKey(),
                RECIPIENT.publicKey(),
                "2",
            );

            const decoded = TransactionBuilder.fromXDR(
                xdrString,
                Networks.TESTNET,
            ) as Transaction;
            const op = decoded.operations[0];

            expect(op.source).toBe(USER.publicKey());
            expect(op.type).toBe("payment");
            expect((op as any).amount).toBe("2.0000000");
        });

        it("uses native XLM as the asset", async () => {
            mockLoadAccount.mockResolvedValue(
                new Account(FEE_PAYER.publicKey(), "300"),
            );

            const xdrString = await service.buildNativePayment(
                FEE_PAYER.publicKey(),
                RECIPIENT.publicKey(),
                "3",
            );

            const decoded = TransactionBuilder.fromXDR(
                xdrString,
                Networks.TESTNET,
            ) as Transaction;
            const op = decoded.operations[0] as any;

            expect(op.asset.isNative()).toBe(true);
        });
    });

    /* ---- buildSponsoredPaymentXDR ---- */

    describe("buildSponsoredPaymentXDR", () => {
        it("returns a decodable XDR for a custom-asset payment", async () => {
            mockLoadAccount.mockResolvedValue(
                new Account(FEE_PAYER.publicKey(), "400"),
            );

            const issuer = Keypair.random().publicKey();
            const xdrString = await service.buildSponsoredPaymentXDR(
                USER.publicKey(),
                RECIPIENT.publicKey(),
                "100",
                "USDC",
                issuer,
            );

            const decoded = TransactionBuilder.fromXDR(
                xdrString,
                Networks.TESTNET,
            ) as Transaction;

            expect(decoded.operations.length).toBe(1);
            expect(decoded.source).toBe(FEE_PAYER.publicKey());
        });

        it("falls back to native when no issuer is provided", async () => {
            mockLoadAccount.mockResolvedValue(
                new Account(FEE_PAYER.publicKey(), "400"),
            );

            const xdrString = await service.buildSponsoredPaymentXDR(
                USER.publicKey(),
                RECIPIENT.publicKey(),
                "10",
            );

            const decoded = TransactionBuilder.fromXDR(
                xdrString,
                Networks.TESTNET,
            ) as Transaction;
            const op = decoded.operations[0] as any;

            expect(op.asset.isNative()).toBe(true);
        });
    });
});
