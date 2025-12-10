package config

import (
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// DRM configuration for CastLabs DRM encryption
type DRM struct {
	Enabled     bool
	KeyID       string
	Key         string
	IV          string
	Mode        string // cbcs or cenc
	CryptBlocks int
	SkipBlocks  int
}

func (DRM) Init(cmd *cobra.Command) error {
	cmd.PersistentFlags().Bool("drm.enabled", false, "enable DRM encryption for WebRTC streams")
	if err := viper.BindPFlag("drm.enabled", cmd.PersistentFlags().Lookup("drm.enabled")); err != nil {
		return err
	}

	cmd.PersistentFlags().String("drm.key_id", "", "DRM key ID (16 bytes hex encoded)")
	if err := viper.BindPFlag("drm.key_id", cmd.PersistentFlags().Lookup("drm.key_id")); err != nil {
		return err
	}

	cmd.PersistentFlags().String("drm.key", "", "DRM encryption key (16 bytes hex encoded)")
	if err := viper.BindPFlag("drm.key", cmd.PersistentFlags().Lookup("drm.key")); err != nil {
		return err
	}

	cmd.PersistentFlags().String("drm.iv", "", "DRM initialization vector (16 bytes hex encoded)")
	if err := viper.BindPFlag("drm.iv", cmd.PersistentFlags().Lookup("drm.iv")); err != nil {
		return err
	}

	cmd.PersistentFlags().String("drm.mode", "cbcs", "DRM encryption mode (cbcs or cenc)")
	if err := viper.BindPFlag("drm.mode", cmd.PersistentFlags().Lookup("drm.mode")); err != nil {
		return err
	}

	cmd.PersistentFlags().Int("drm.crypt_blocks", 1, "CBCS pattern: number of blocks to encrypt")
	if err := viper.BindPFlag("drm.crypt_blocks", cmd.PersistentFlags().Lookup("drm.crypt_blocks")); err != nil {
		return err
	}

	cmd.PersistentFlags().Int("drm.skip_blocks", 9, "CBCS pattern: number of blocks to skip")
	if err := viper.BindPFlag("drm.skip_blocks", cmd.PersistentFlags().Lookup("drm.skip_blocks")); err != nil {
		return err
	}

	return nil
}

func (s *DRM) Set() {
	s.Enabled = viper.GetBool("drm.enabled")
	s.KeyID = viper.GetString("drm.key_id")
	s.Key = viper.GetString("drm.key")
	s.IV = viper.GetString("drm.iv")
	s.Mode = viper.GetString("drm.mode")
	s.CryptBlocks = viper.GetInt("drm.crypt_blocks")
	s.SkipBlocks = viper.GetInt("drm.skip_blocks")
}
