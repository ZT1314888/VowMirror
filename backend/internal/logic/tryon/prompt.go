package tryon

import (
	"fmt"

	"backend/internal/catalog"
)

const identityAndClothing = "Create exactly one landscape full-body wedding photograph of the same two people from reference 1 (couple). Use reference 1 only for the two people's identities and appearance. Preserve both identities, faces, and natural proportions, but freely move, turn, and re-pose them to perform the specified action. Decide from reference 1 which person should wear the wedding dress, judging only by what the photo shows. That person must wear only the wedding dress from reference 2 (dress). The other person must wear only the menswear, including shoes, from reference 3 (menswear), with shoe details from reference 4 (shoes_detail). Do not mix garments. Show both people from head to toe, including complete shoes, without cropping."

const limbAndFootwear = "There are exactly two people. Each person has exactly two arms, two hands, two legs, and two feet. Preserve two coherent hip-knee-ankle-foot chains per person, including where fabric covers them. Do not create disconnected or duplicated limbs, extra feet, or additional shoes. Never duplicate a foot or shoe to satisfy a visibility or framing requirement. The wedding-dress wearer's footwear, when visible, forms one consistent matching pair attached to their two feet. Reference 4 specifies only the menswear wearer's shoe details. Let the referenced garments drape and deform naturally with the action and around the actual leg forms; do not shorten or replace garments just to reveal limbs. Do not retain the couple photo's original standing pose."

func couplePrompt(refs []Reference, pose catalog.Pose) string {
	background := "Preserve the original background from reference 1."
	lineart := ""
	for index, ref := range refs {
		if ref.Role == RoleScene {
			background = fmt.Sprintf("Use reference %d only for the venue; preserve its architecture, stage and decorations without replacing the people.", index+1)
		}
		if ref.Role == RolePose {
			lineart = fmt.Sprintf(" Use reference %d only as a specification for this action's relative body arrangement, limb placement and supporting contact relationships. Follow the action text's explicit image-left/image-right directions. Do not copy the line drawing's identities, faces, clothing, footwear, body shape or background.", index+1)
		}
	}
	return identityAndClothing + " " + background + " " + pose.Action + lineart + " " + limbAndFootwear
}
