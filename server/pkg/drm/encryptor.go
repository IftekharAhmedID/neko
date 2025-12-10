// Package drm provides CBCS/CENC encryption for H.264 streams
// Compatible with CastLabs rtc-drm-transform browser decryption
package drm

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/hex"
	"errors"
	"sync"
)

// Encryptor handles CBCS encryption of H.264 NAL units
type Encryptor struct {
	mu       sync.Mutex
	enabled  bool
	keyID    []byte
	key      []byte
	iv       []byte
	block    cipher.Block
	mode     string // "cbcs" or "cenc"

	// CBCS pattern: encrypt cryptBlocks, skip skipBlocks (typically 1:9)
	cryptBlocks int
	skipBlocks  int
}

// Config holds DRM encryption configuration
type Config struct {
	Enabled     bool
	KeyID       string // hex encoded 16 bytes
	Key         string // hex encoded 16 bytes
	IV          string // hex encoded 16 bytes
	Mode        string // "cbcs" or "cenc"
	CryptBlocks int    // for CBCS pattern (default 1)
	SkipBlocks  int    // for CBCS pattern (default 9)
}

// NewEncryptor creates a new DRM encryptor
func NewEncryptor(cfg Config) (*Encryptor, error) {
	if !cfg.Enabled {
		return &Encryptor{enabled: false}, nil
	}

	keyID, err := hex.DecodeString(cfg.KeyID)
	if err != nil || len(keyID) != 16 {
		return nil, errors.New("keyID must be 16 bytes hex encoded")
	}

	key, err := hex.DecodeString(cfg.Key)
	if err != nil || len(key) != 16 {
		return nil, errors.New("key must be 16 bytes hex encoded")
	}

	iv, err := hex.DecodeString(cfg.IV)
	if err != nil || len(iv) != 16 {
		return nil, errors.New("iv must be 16 bytes hex encoded")
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	mode := cfg.Mode
	if mode == "" {
		mode = "cbcs"
	}

	cryptBlocks := cfg.CryptBlocks
	if cryptBlocks <= 0 {
		cryptBlocks = 1
	}

	skipBlocks := cfg.SkipBlocks
	if skipBlocks < 0 {
		skipBlocks = 9
	}

	return &Encryptor{
		enabled:     true,
		keyID:       keyID,
		key:         key,
		iv:          iv,
		block:       block,
		mode:        mode,
		cryptBlocks: cryptBlocks,
		skipBlocks:  skipBlocks,
	}, nil
}

// Enabled returns whether encryption is active
func (e *Encryptor) Enabled() bool {
	return e.enabled
}

// KeyID returns the key ID for license requests
func (e *Encryptor) KeyID() []byte {
	return e.keyID
}

// IV returns the initialization vector
func (e *Encryptor) IV() []byte {
	return e.iv
}

// Mode returns "cbcs" or "cenc"
func (e *Encryptor) Mode() string {
	return e.mode
}

// Encrypt encrypts H.264 NAL units using CBCS pattern encryption
// Input: raw H.264 access unit (may contain multiple NAL units)
// Output: encrypted H.264 access unit
func (e *Encryptor) Encrypt(data []byte) ([]byte, error) {
	if !e.enabled || len(data) == 0 {
		return data, nil
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	if e.mode == "cbcs" {
		return e.encryptCBCS(data)
	}
	return e.encryptCENC(data)
}

// encryptCBCS implements CBCS (AES-CBC with pattern) encryption
// Pattern: encrypt cryptBlocks of 16 bytes, skip skipBlocks of 16 bytes
func (e *Encryptor) encryptCBCS(data []byte) ([]byte, error) {
	// Find NAL units and encrypt their payloads
	nalus := parseNALUnits(data)
	result := make([]byte, 0, len(data))

	for _, nalu := range nalus {
		if len(nalu) < 2 {
			result = append(result, nalu...)
			continue
		}

		// NAL unit header is first byte (or first 2 bytes for H.265)
		// Keep header clear, encrypt payload with pattern
		header := nalu[0]
		nalType := header & 0x1F

		// Only encrypt VCL NAL units (1-5 for H.264)
		if nalType >= 1 && nalType <= 5 && len(nalu) > 1 {
			encrypted := e.encryptWithPattern(nalu[1:])
			result = append(result, header)
			result = append(result, encrypted...)
		} else {
			result = append(result, nalu...)
		}
	}

	return result, nil
}

// encryptWithPattern applies CBCS pattern encryption
func (e *Encryptor) encryptWithPattern(data []byte) []byte {
	if len(data) < 16 {
		return data // Too small to encrypt
	}

	result := make([]byte, len(data))
	copy(result, data)

	blockSize := 16
	pattern := e.cryptBlocks + e.skipBlocks
	iv := make([]byte, 16)
	copy(iv, e.iv)

	pos := 0
	blockNum := 0

	for pos+blockSize <= len(data) {
		patternPos := blockNum % pattern

		if patternPos < e.cryptBlocks {
			// Encrypt this block using CBC
			mode := cipher.NewCBCEncrypter(e.block, iv)
			mode.CryptBlocks(result[pos:pos+blockSize], data[pos:pos+blockSize])
			// Update IV for next encrypted block
			copy(iv, result[pos:pos+blockSize])
		}
		// Skip blocks are left as-is

		pos += blockSize
		blockNum++
	}

	return result
}

// encryptCENC implements CENC (AES-CTR) encryption
func (e *Encryptor) encryptCENC(data []byte) ([]byte, error) {
	// CENC uses AES-CTR mode
	nalus := parseNALUnits(data)
	result := make([]byte, 0, len(data))

	for _, nalu := range nalus {
		if len(nalu) < 2 {
			result = append(result, nalu...)
			continue
		}

		header := nalu[0]
		nalType := header & 0x1F

		// Only encrypt VCL NAL units
		if nalType >= 1 && nalType <= 5 && len(nalu) > 1 {
			ctr := cipher.NewCTR(e.block, e.iv)
			encrypted := make([]byte, len(nalu)-1)
			ctr.XORKeyStream(encrypted, nalu[1:])
			result = append(result, header)
			result = append(result, encrypted...)
		} else {
			result = append(result, nalu...)
		}
	}

	return result, nil
}

// parseNALUnits finds NAL unit boundaries in H.264 byte stream
// Looks for start codes: 0x000001 or 0x00000001
func parseNALUnits(data []byte) [][]byte {
	var nalus [][]byte
	start := -1

	for i := 0; i < len(data)-2; i++ {
		// Check for 3-byte start code (0x000001)
		if data[i] == 0 && data[i+1] == 0 && data[i+2] == 1 {
			if start >= 0 {
				nalus = append(nalus, data[start:i])
			}
			start = i + 3
			continue
		}
		// Check for 4-byte start code (0x00000001)
		if i < len(data)-3 && data[i] == 0 && data[i+1] == 0 && data[i+2] == 0 && data[i+3] == 1 {
			if start >= 0 {
				nalus = append(nalus, data[start:i])
			}
			start = i + 4
			i++ // Skip extra byte
			continue
		}
	}

	// Last NAL unit
	if start >= 0 && start < len(data) {
		nalus = append(nalus, data[start:])
	}

	// If no start codes found, treat entire data as one NAL
	if len(nalus) == 0 && len(data) > 0 {
		nalus = append(nalus, data)
	}

	return nalus
}
