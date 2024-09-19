// Package fakes is an in-memory stand-in for the Fabric shim, enough to run the ehr contract's
// transactions in plain `go test` with no peer. Writes apply immediately (there is no MVCC), and
// every write is logged so GetHistoryForKey works.
package fakes

import (
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-protos-go-apiv2/ledger/queryresult"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type Event struct {
	Name    string
	Payload []byte
}

type write struct {
	txID     string
	ts       time.Time
	value    []byte
	isDelete bool
}

// Stub embeds the interface so unimplemented methods panic loudly if the contract starts using
// them.
type Stub struct {
	shim.ChaincodeStubInterface

	State   map[string][]byte
	Private map[string]map[string][]byte
	// Hashes mirrors the peer's separate store of private-data hashes (kept on every peer,
	// including ones that never received the data).
	Hashes    map[string]map[string][]byte
	Transient map[string][]byte
	Events    []Event

	txID    string
	txTime  time.Time
	txEvent *Event
	history map[string][]write
	seq     int
}

func NewStub(start time.Time) *Stub {
	return &Stub{
		State:   map[string][]byte{},
		Private: map[string]map[string][]byte{},
		Hashes:  map[string]map[string][]byte{},
		history: map[string][]write{},
		txTime:  start.UTC(),
	}
}

// BeginTx starts a new transaction: a fresh deterministic tx ID, the given timestamp, and
// cleared transient data. It flushes the previous transaction's event.
func (s *Stub) BeginTx(at time.Time, transient map[string][]byte) {
	s.EndTx()
	s.seq++
	sum := sha256.Sum256([]byte(fmt.Sprintf("tx-%d", s.seq)))
	s.txID = fmt.Sprintf("%x", sum)
	s.txTime = at.UTC()
	s.Transient = transient
}

func (s *Stub) EndTx() {
	if s.txEvent != nil {
		s.Events = append(s.Events, *s.txEvent)
		s.txEvent = nil
	}
}

func (s *Stub) Now() time.Time { return s.txTime }

func (s *Stub) GetTxID() string      { return s.txID }
func (s *Stub) GetChannelID() string { return "ehrchannel" }
func (s *Stub) GetTxTimestamp() (*timestamppb.Timestamp, error) {
	return timestamppb.New(s.txTime), nil
}

func (s *Stub) GetState(key string) ([]byte, error) { return s.State[key], nil }

func (s *Stub) PutState(key string, value []byte) error {
	if key == "" {
		return fmt.Errorf("empty key")
	}
	s.State[key] = append([]byte(nil), value...)
	s.history[key] = append(s.history[key], write{txID: s.txID, ts: s.txTime, value: s.State[key]})
	return nil
}

func (s *Stub) DelState(key string) error {
	delete(s.State, key)
	s.history[key] = append(s.history[key], write{txID: s.txID, ts: s.txTime, isDelete: true})
	return nil
}

func (s *Stub) CreateCompositeKey(objectType string, attributes []string) (string, error) {
	return shim.CreateCompositeKey(objectType, attributes)
}

func (s *Stub) SplitCompositeKey(compositeKey string) (string, []string, error) {
	return (&shim.ChaincodeStub{}).SplitCompositeKey(compositeKey)
}

func (s *Stub) GetStateByPartialCompositeKey(objectType string, keys []string) (shim.StateQueryIteratorInterface, error) {
	prefix, err := shim.CreateCompositeKey(objectType, keys)
	if err != nil {
		return nil, err
	}
	var ks []string
	for k := range s.State {
		if strings.HasPrefix(k, prefix) {
			ks = append(ks, k)
		}
	}
	sort.Strings(ks)
	kvs := make([]*queryresult.KV, 0, len(ks))
	for _, k := range ks {
		kvs = append(kvs, &queryresult.KV{Key: k, Value: s.State[k]})
	}
	return &kvIterator{items: kvs}, nil
}

func (s *Stub) GetHistoryForKey(key string) (shim.HistoryQueryIteratorInterface, error) {
	ws := s.history[key]
	mods := make([]*queryresult.KeyModification, 0, len(ws))
	// Fabric returns newest first.
	for i := len(ws) - 1; i >= 0; i-- {
		w := ws[i]
		mods = append(mods, &queryresult.KeyModification{TxId: w.txID, Value: w.value,
			Timestamp: timestamppb.New(w.ts), IsDelete: w.isDelete})
	}
	return &historyIterator{items: mods}, nil
}

func (s *Stub) GetTransient() (map[string][]byte, error) {
	if s.Transient == nil {
		return map[string][]byte{}, nil
	}
	return s.Transient, nil
}

func (s *Stub) coll(name string) map[string][]byte {
	if s.Private[name] == nil {
		s.Private[name] = map[string][]byte{}
	}
	return s.Private[name]
}

func (s *Stub) hashes(name string) map[string][]byte {
	if s.Hashes[name] == nil {
		s.Hashes[name] = map[string][]byte{}
	}
	return s.Hashes[name]
}

func (s *Stub) PutPrivateData(collection, key string, value []byte) error {
	s.coll(collection)[key] = append([]byte(nil), value...)
	sum := sha256.Sum256(value)
	s.hashes(collection)[key] = sum[:]
	return nil
}

func (s *Stub) GetPrivateData(collection, key string) ([]byte, error) {
	return s.coll(collection)[key], nil
}

// GetPrivateDataHash returns the SHA-256 recorded at write time, nil if never written.
func (s *Stub) GetPrivateDataHash(collection, key string) ([]byte, error) {
	return s.hashes(collection)[key], nil
}

func (s *Stub) DelPrivateData(collection, key string) error {
	delete(s.coll(collection), key)
	delete(s.hashes(collection), key)
	return nil
}

func (s *Stub) PurgePrivateData(collection, key string) error {
	delete(s.coll(collection), key)
	delete(s.hashes(collection), key)
	return nil
}

// SetEvent keeps only the last event of a transaction, like Fabric.
func (s *Stub) SetEvent(name string, payload []byte) error {
	if name == "" {
		return fmt.Errorf("event name can not be empty string")
	}
	s.txEvent = &Event{Name: name, Payload: payload}
	return nil
}

// LastEvent returns the current transaction's event, if any.
func (s *Stub) LastEvent() *Event { return s.txEvent }

type kvIterator struct {
	items []*queryresult.KV
	i     int
}

func (it *kvIterator) HasNext() bool { return it.i < len(it.items) }
func (it *kvIterator) Close() error  { return nil }
func (it *kvIterator) Next() (*queryresult.KV, error) {
	if !it.HasNext() {
		return nil, fmt.Errorf("iterator exhausted")
	}
	it.i++
	return it.items[it.i-1], nil
}

type historyIterator struct {
	items []*queryresult.KeyModification
	i     int
}

func (it *historyIterator) HasNext() bool { return it.i < len(it.items) }
func (it *historyIterator) Close() error  { return nil }
func (it *historyIterator) Next() (*queryresult.KeyModification, error) {
	if !it.HasNext() {
		return nil, fmt.Errorf("iterator exhausted")
	}
	it.i++
	return it.items[it.i-1], nil
}
