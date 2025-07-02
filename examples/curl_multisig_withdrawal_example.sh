#!/bin/bash

# Example curl command for a bank to initiate a multi-signature withdrawal.
# This is the "last mile" activation for customer funds.

API_URL="https://ortenberg-crypto-host.onrender.com/api/v2/withdrawal/initiate"
API_KEY="sk_live_ortenberg_client_001" # The bank's API key for your service

# The bank's system constructs this payload after an internal officer action.
# The key element is `partially_signed_tx`, which is the transaction
# signed with the BANK'S key from the multi-sig wallet.
read -r -d '' WITHDRAWAL_DATA << EOM
{
  "request_id": "bank-tx-id-12345-abcdef",
  "treasury_contract_address": "0x...MultiSigWalletAddress...",
  "destination_address": "0x...CustomerExternalWalletAddress...",
  "token_contract_address": "0x...UsdtContractAddress...",
  "amount": "1500.00",
  "partially_signed_tx": "0x_long_hex_string_representing_the_banks_signature_data"
}
EOM

curl -X POST "$API_URL" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$WITHDRAWAL_DATA"