package contract

import "strings"

// BootstrapAdmin registers the caller as its org's first administrator. It only works once per
// MSP, and only for a certificate the org CA issued with ehr.role=admin.
func (c *EHRContract) BootstrapAdmin(ctx Ctx) (*Member, error) {
	id, err := readCert(ctx)
	if err != nil {
		return nil, err
	}
	if id.Role != RoleAdmin {
		return nil, errDenied("only an admin certificate can bootstrap")
	}
	var marker struct{ AdminID string }
	mk, err := key(ctx, objOrgAdmin, id.Org)
	if err != nil {
		return nil, err
	}
	exists, err := getJSON(ctx, mk, &marker)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, errConflict("%s already has an administrator (%s)", id.Org, marker.AdminID)
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	m := Member{ID: id.ID, Role: RoleAdmin, Org: id.Org, EnrollmentID: id.EnrollmentID, Active: true,
		RegisteredBy: "bootstrap", UpdatedAt: stamp(now)}
	if err := putObj(ctx, m, objAdmin, m.ID); err != nil {
		return nil, err
	}
	marker.AdminID = m.ID
	if err := putJSON(ctx, mk, marker); err != nil {
		return nil, err
	}
	return &m, emit(ctx, "MemberRegistered", m)
}

func (c *EHRContract) RegisterPatient(ctx Ctx, pid, enrollmentID string) (*Member, error) {
	return c.register(ctx, RolePatient, pid, enrollmentID, "")
}

func (c *EHRContract) RegisterProvider(ctx Ctx, did, enrollmentID, specialty string) (*Member, error) {
	return c.register(ctx, RoleDoctor, did, enrollmentID, specialty)
}

func (c *EHRContract) RegisterAdmin(ctx Ctx, aid, enrollmentID string) (*Member, error) {
	return c.register(ctx, RoleAdmin, aid, enrollmentID, "")
}

// register writes a registry entry in the admin's own org. IDs are unique across roles, so a
// doctor and a patient can never share an ehr.id.
func (c *EHRContract) register(ctx Ctx, role, id, enrollmentID, specialty string) (*Member, error) {
	admin, err := requireRole(ctx, RoleAdmin)
	if err != nil {
		return nil, err
	}
	if !validID(id) || strings.TrimSpace(enrollmentID) == "" {
		return nil, errInvalid("id and enrollmentId are required")
	}
	for _, role := range memberRoles {
		existing, err := getObj[Member](ctx, memberObject[role], id)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			return nil, errConflict("%s is already registered", id)
		}
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	m := Member{ID: id, Role: role, Org: admin.Org, EnrollmentID: enrollmentID, Specialty: specialty,
		Active: true, RegisteredBy: admin.ID, UpdatedAt: stamp(now)}
	if err := putObj(ctx, m, memberObject[role], id); err != nil {
		return nil, err
	}
	return &m, emit(ctx, "MemberRegistered", m)
}

func (c *EHRContract) SetProviderActive(ctx Ctx, did string, active bool) (*Member, error) {
	return c.setActive(ctx, did, active, RoleDoctor)
}

// DeactivateUser disables any member of the admin's org. It takes effect at the next block:
// every transaction re-reads the caller's registry entry.
func (c *EHRContract) DeactivateUser(ctx Ctx, id string) (*Member, error) {
	return c.setActive(ctx, id, false, "")
}

func (c *EHRContract) setActive(ctx Ctx, id string, active bool, onlyRole string) (*Member, error) {
	admin, err := requireRole(ctx, RoleAdmin)
	if err != nil {
		return nil, err
	}
	var m *Member
	for _, role := range memberRoles {
		if onlyRole != "" && role != onlyRole {
			continue
		}
		if m, err = getObj[Member](ctx, memberObject[role], id); err != nil {
			return nil, err
		}
		if m != nil {
			break
		}
	}
	if m == nil {
		return nil, errNotFound("member %s", id)
	}
	if m.Org != admin.Org {
		return nil, errDenied("%s belongs to %s", id, m.Org)
	}
	if m.ID == admin.ID && !active {
		return nil, errInvalid("an administrator cannot deactivate themselves")
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	m.Active = active
	m.UpdatedAt = stamp(now)
	if err := putObj(ctx, m, memberObject[m.Role], id); err != nil {
		return nil, err
	}
	return m, emit(ctx, "MemberStatusChanged", m)
}

func (c *EHRContract) GetMember(ctx Ctx, id string) (*Member, error) {
	if _, err := currentActor(ctx); err != nil {
		return nil, err
	}
	for _, role := range memberRoles {
		m, err := getObj[Member](ctx, memberObject[role], id)
		if err != nil {
			return nil, err
		}
		if m != nil {
			return m, nil
		}
	}
	return nil, errNotFound("member %s", id)
}

// ListProviders is the directory patients choose consent grantees from.
func (c *EHRContract) ListProviders(ctx Ctx) ([]Member, error) {
	if _, err := currentActor(ctx); err != nil {
		return nil, err
	}
	return listObj[Member](ctx, objProvider)
}

func (c *EHRContract) ListOrgMembers(ctx Ctx) ([]Member, error) {
	admin, err := requireRole(ctx, RoleAdmin)
	if err != nil {
		return nil, err
	}
	out := []Member{}
	for _, obj := range []string{objPatient, objProvider, objAdmin} {
		ms, err := listObj[Member](ctx, obj)
		if err != nil {
			return nil, err
		}
		for _, m := range ms {
			if m.Org == admin.Org {
				out = append(out, m)
			}
		}
	}
	return out, nil
}

func validID(id string) bool {
	if len(id) < 3 || len(id) > 32 {
		return false
	}
	for _, r := range id {
		if !(r == '-' || r == '_' || (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')) {
			return false
		}
	}
	return true
}
