package contract

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

type Ctx = contractapi.TransactionContextInterface

// Error prefixes are part of the gateway contract: it maps them to HTTP status codes.
func errDenied(format string, a ...any) error {
	return fmt.Errorf("ACCESS_DENIED: "+format, a...)
}
func errNotFound(format string, a ...any) error {
	return fmt.Errorf("NOT_FOUND: "+format, a...)
}
func errInvalid(format string, a ...any) error {
	return fmt.Errorf("INVALID: "+format, a...)
}
func errConflict(format string, a ...any) error {
	return fmt.Errorf("CONFLICT: "+format, a...)
}
func errIntegrity(format string, a ...any) error {
	return fmt.Errorf("INTEGRITY: "+format, a...)
}

func key(ctx Ctx, obj string, attrs ...string) (string, error) {
	return ctx.GetStub().CreateCompositeKey(obj, attrs)
}

// getJSON loads a value into out. It returns (false, nil) when the key is absent.
func getJSON(ctx Ctx, k string, out any) (bool, error) {
	b, err := ctx.GetStub().GetState(k)
	if err != nil {
		return false, err
	}
	if b == nil {
		return false, nil
	}
	return true, json.Unmarshal(b, out)
}

func putJSON(ctx Ctx, k string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(k, b)
}

func getObj[T any](ctx Ctx, obj string, attrs ...string) (*T, error) {
	k, err := key(ctx, obj, attrs...)
	if err != nil {
		return nil, err
	}
	var v T
	ok, err := getJSON(ctx, k, &v)
	if err != nil || !ok {
		return nil, err
	}
	return &v, nil
}

func putObj(ctx Ctx, v any, obj string, attrs ...string) error {
	k, err := key(ctx, obj, attrs...)
	if err != nil {
		return err
	}
	return putJSON(ctx, k, v)
}

// listObj returns every value under a partial composite key.
func listObj[T any](ctx Ctx, obj string, attrs ...string) ([]T, error) {
	it, err := ctx.GetStub().GetStateByPartialCompositeKey(obj, attrs)
	if err != nil {
		return nil, err
	}
	defer it.Close()
	out := []T{}
	for it.HasNext() {
		kv, err := it.Next()
		if err != nil {
			return nil, err
		}
		var v T
		if err := json.Unmarshal(kv.Value, &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// txTime is the proposal timestamp. It is identical on every endorser, unlike time.Now().
func txTime(ctx Ctx) (time.Time, error) {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return time.Time{}, err
	}
	return ts.AsTime().UTC(), nil
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// newID derives a deterministic identifier from the transaction ID.
func newID(ctx Ctx, prefix string) string {
	txid := ctx.GetStub().GetTxID()
	if len(txid) > 16 {
		txid = txid[:16]
	}
	return prefix + txid
}

// emit sets the transaction's single chaincode event. Fabric keeps only the last SetEvent.
func emit(ctx Ctx, name string, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return ctx.GetStub().SetEvent(name, b)
}

type indexRef struct {
	PatientID string `json:"patientId"`
	Grantee   string `json:"grantee,omitempty"`
}

func lookupIndex(ctx Ctx, obj, id string) (*indexRef, error) {
	return getObj[indexRef](ctx, obj, id)
}
