package com.acme.shop.domain;

import jakarta.persistence.Embedded;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.OneToMany;
import jakarta.persistence.Table;
import jakarta.persistence.Transient;

import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "customers")
public class Customer extends BaseEntity {

    private String email;

    private String fullName;

    @Enumerated(EnumType.STRING)
    private CustomerStatus status;

    @Embedded
    private Address address;

    @OneToMany(mappedBy = "customer")
    private List<PurchaseOrder> orders = new ArrayList<>();

    @Transient
    private String displayLabel;

    public static final int MAX_ORDERS = 100;
}
